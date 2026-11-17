/**
 * A deliberately small YAML frontmatter reader for SKILL.md files.
 *
 * Supported subset (documented in README):
 *   key: plain scalar          key: "quoted \n scalar"      key: 'single '' quoted'
 *   key: [a, b]                key: |  / key: >  (block text)
 *   key:\n  - a\n  - b          comments, blank lines, BOM, CRLF
 *
 * Not supported: nested mappings, anchors, aliases, multiple documents,
 * unquoted multi-line scalars and YAML type tags. Unsupported structure is
 * reported instead of silently guessed.
 */

function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) {
        if (quote === "'" && raw[i + 1] === "'") i += 1;
        else quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function parseDoubleQuoted(raw, lineNo, errors) {
  let out = '';
  for (let i = 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      if (raw.slice(i + 1).trim() !== '') {
        errors.push({ line: lineNo, message: 'unexpected text after closing double quote' });
      }
      return out;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    i += 1;
    const escapes = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '0': '\0' };
    if (next in escapes) out += escapes[next];
    else if (next === 'u') {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        errors.push({ line: lineNo, message: 'invalid \\u escape in double-quoted scalar' });
        out += 'u';
      } else {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    } else {
      errors.push({ line: lineNo, message: `unsupported escape \\${next ?? ''} in double-quoted scalar` });
      out += next ?? '';
    }
  }
  errors.push({ line: lineNo, message: 'unterminated double-quoted scalar' });
  return out;
}

function parseSingleQuoted(raw, lineNo, errors) {
  let out = '';
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] !== "'") {
      out += raw[i];
      continue;
    }
    if (raw[i + 1] === "'") {
      out += "'";
      i += 1;
      continue;
    }
    if (raw.slice(i + 1).trim() !== '') {
      errors.push({ line: lineNo, message: 'unexpected text after closing single quote' });
    }
    return out;
  }
  errors.push({ line: lineNo, message: 'unterminated single-quoted scalar' });
  return out;
}

function splitInlineList(inner, lineNo, errors) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += inner[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          current += "'";
          i += 1;
        } else quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (quote) errors.push({ line: lineNo, message: 'unterminated quote inside inline list' });
  if (current.trim() !== '' || inner.endsWith(',')) parts.push(current.trim());
  return parts.filter((part, index) => !(part === '' && index === parts.length - 1));
}

function parseScalar(rawValue, lineNo, errors) {
  const raw = stripComment(rawValue).trim();
  if (raw === '') return '';
  if (raw.startsWith('"')) return parseDoubleQuoted(raw, lineNo, errors);
  if (raw.startsWith("'")) return parseSingleQuoted(raw, lineNo, errors);
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) {
      errors.push({ line: lineNo, message: 'inline list must close with ] on the same line' });
      return raw;
    }
    const values = splitInlineList(raw.slice(1, -1), lineNo, errors);
    return values.map((item) => parseScalar(item, lineNo, errors));
  }
  if (raw.startsWith('!!')) {
    errors.push({ line: lineNo, message: 'YAML type tags are not supported' });
    return raw.replace(/^!!\S+\s*/, '');
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function indentation(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replaceAll('\t', '  ').length : 0;
}

function foldBlock(lines, style) {
  if (style === '|') return lines.join('\n');
  const output = [];
  for (const line of lines) {
    if (line === '') {
      output.push('\n');
      continue;
    }
    if (output.length > 0) {
      const last = output[output.length - 1];
      if (!last.endsWith('\n')) output.push(' ');
    }
    output.push(line);
  }
  return output.join('');
}

function chompBlock(value, chomp) {
  if (chomp === '-') return value.replace(/\n+$/, '');
  if (chomp === '+') return `${value}\n`;
  return `${value.replace(/\n+$/, '')}\n`;
}

function nextContentLine(lines, start) {
  let index = start;
  while (index < lines.length) {
    if (lines[index].trim() !== '' && !lines[index].trimStart().startsWith('#')) return index;
    index += 1;
  }
  return index;
}

/**
 * Parse one optional nested mapping (for common `metadata:` blocks) without
 * making the whole skill invalid. Unsupported deeper structure is skipped with
 * a warning. Values remain data and are never invented.
 */
function parseNestedMap(lines, start, indent, lineBase, errors, warnings, depth = 0, parentKey = '') {
  const data = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      warnings.push({
        line: lineBase + i,
        message: `unsupported indentation under optional metadata ${parentKey}; line skipped`,
      });
      i += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/.exec(line);
    if (!match) {
      warnings.push({
        line: lineBase + i,
        message: `unsupported nested metadata line skipped: ${line.trim().slice(0, 80)}`,
      });
      i += 1;
      continue;
    }
    const key = match[1];
    const rawValue = match[2] ?? '';
    if (Object.hasOwn(data, key)) {
      warnings.push({ line: lineBase + i, message: `duplicate optional metadata key: ${key}` });
    }
    i += 1;
    const blockMatch = /^([|>])([+-]?)(\d?)\s*(?:#.*)?$/.exec(rawValue.trim());
    if (blockMatch) {
      const collected = [];
      let blockIndent = blockMatch[3] ? Number(blockMatch[3]) : null;
      while (i < lines.length) {
        const blockLine = lines[i];
        if (blockLine.trim() === '') {
          collected.push('');
          i += 1;
          continue;
        }
        const blockLineIndent = indentation(blockLine);
        if (blockLineIndent <= indent) break;
        if (blockIndent === null) blockIndent = blockLineIndent;
        if (blockLineIndent < blockIndent) break;
        collected.push(blockLine.slice(blockIndent));
        i += 1;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      data[key] = chompBlock(foldBlock(collected, blockMatch[1]), blockMatch[2]);
      continue;
    }
    const cleaned = stripComment(rawValue).trim();
    if (cleaned !== '') {
      data[key] = parseScalar(cleaned, lineBase + i - 1, errors);
      continue;
    }
    const lookahead = nextContentLine(lines, i);
    if (lookahead < lines.length && indentation(lines[lookahead]) > indent) {
      const childIndent = indentation(lines[lookahead]);
      if (/^\s*-/.test(lines[lookahead])) {
        const list = [];
        let j = lookahead;
        while (j < lines.length) {
          const itemLine = lines[j];
          if (itemLine.trim() === '') {
            j += 1;
            continue;
          }
          const itemIndent = indentation(itemLine);
          if (itemIndent < childIndent) break;
          const item = /^\s*-\s*(.*)$/.exec(itemLine);
          if (!item) {
            warnings.push({
              line: lineBase + j,
              message: `unsupported list item under optional metadata ${key}; skipped`,
            });
            j += 1;
            continue;
          }
          list.push(parseScalar(item[1], lineBase + j, errors));
          j += 1;
        }
        data[key] = list;
        i = j;
        continue;
      }
      if (depth >= 3) {
        warnings.push({
          line: lineBase + lookahead,
          message: `optional metadata ${parentKey ? `${parentKey}.` : ''}${key} is nested too deeply; skipped`,
        });
        i = lookahead;
        while (i < lines.length && (lines[i].trim() === '' || indentation(lines[i]) > indent)) i += 1;
        data[key] = null;
        continue;
      }
      const nested = parseNestedMap(
        lines,
        lookahead,
        childIndent,
        lineBase,
        errors,
        warnings,
        depth + 1,
        parentKey ? `${parentKey}.${key}` : key,
      );
      data[key] = nested.data;
      i = nested.next;
      continue;
    }
    data[key] = '';
  }
  return { data, next: i };
}

export function parseFrontmatter(source, { maxBytes = 1024 * 1024 } = {}) {
  const errors = [];
  const warnings = [];
  let text = String(source ?? '');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return {
      ok: false,
      data: {},
      body: '',
      errors: [{ line: 0, message: `SKILL.md exceeds frontmatter/read limit of ${maxBytes} bytes` }],
      warnings,
    };
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first += 1;
  if (first >= lines.length || lines[first].trim() !== '---') {
    return {
      ok: false,
      data: {},
      body: text,
      errors: [{ line: first + 1, message: 'missing opening --- frontmatter delimiter' }],
      warnings,
    };
  }
  let close = -1;
  for (let i = first + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return {
      ok: false,
      data: {},
      body: text,
      errors: [{ line: first + 1, message: 'missing closing --- frontmatter delimiter' }],
      warnings,
    };
  }

  const data = {};
  const seen = new Set();
  const fmLines = lines.slice(first + 1, close);
  let i = 0;
  while (i < fmLines.length) {
    const rawLine = fmLines[i];
    const lineNo = first + 2 + i;
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    if (indentation(rawLine) > 0) {
      errors.push({ line: lineNo, message: 'unexpected indented line (nested mappings are not supported)' });
      i += 1;
      continue;
    }
    const keyMatch = /^([A-Za-z0-9_.-]+)\s*:(?:\s*(.*))?$/.exec(rawLine);
    if (!keyMatch) {
      errors.push({ line: lineNo, message: `malformed frontmatter line: ${rawLine.slice(0, 120)}` });
      i += 1;
      continue;
    }
    const key = keyMatch[1];
    const rawValue = keyMatch[2] ?? '';
    if (seen.has(key)) errors.push({ line: lineNo, message: `duplicate frontmatter key: ${key}` });
    seen.add(key);
    i += 1;

    const blockMatch = /^([|>])([+-]?)(\d?)\s*(?:#.*)?$/.exec(rawValue.trim());
    if (blockMatch) {
      const style = blockMatch[1];
      const chomp = blockMatch[2];
      const explicitIndent = blockMatch[3] ? Number(blockMatch[3]) : 0;
      const collected = [];
      let blockIndent = explicitIndent || null;
      while (i < fmLines.length) {
        const line = fmLines[i];
        if (line.trim() === '') {
          collected.push('');
          i += 1;
          continue;
        }
        const indent = indentation(line);
        if (indent === 0) break;
        if (blockIndent === null) blockIndent = indent;
        if (indent < blockIndent) break;
        collected.push(line.slice(blockIndent));
        i += 1;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      data[key] = chompBlock(foldBlock(collected, style), chomp);
      continue;
    }

    const cleaned = stripComment(rawValue).trim();
    if (cleaned === '') {
      // A block list or an optional nested mapping (commonly `metadata:`) may follow.
      const lookahead = nextContentLine(fmLines, i);
      if (lookahead < fmLines.length && indentation(fmLines[lookahead]) > 0 && !/^\s*-/.test(fmLines[lookahead])) {
        const nested = parseNestedMap(
          fmLines,
          lookahead,
          indentation(fmLines[lookahead]),
          first + 2,
          errors,
          warnings,
          0,
          key,
        );
        data[key] = nested.data;
        i = nested.next;
        continue;
      }
      const list = [];
      let j = i;
      let itemIndent = null;
      while (j < fmLines.length) {
        const line = fmLines[j];
        if (line.trim() === '' || line.trimStart().startsWith('#')) {
          j += 1;
          continue;
        }
        const indent = indentation(line);
        if (indent === 0) break;
        const item = /^\s*-\s*(.*)$/.exec(line);
        if (!item) {
          errors.push({
            line: first + 2 + j,
            message: `nested mapping is not supported (key ${key}); use flat keys or a list`,
          });
          while (j < fmLines.length && (fmLines[j].trim() === '' || indentation(fmLines[j]) > 0)) j += 1;
          break;
        }
        if (itemIndent === null) itemIndent = indent;
        list.push(parseScalar(item[1], first + 2 + j, errors));
        j += 1;
      }
      if (list.length > 0) {
        data[key] = list;
        i = j;
        continue;
      }
      data[key] = '';
      continue;
    }
    data[key] = parseScalar(cleaned, lineNo, errors);
  }

  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '');
  return { ok: errors.length === 0, data, body, errors, warnings };
}

export function normalizeStringList(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list
    .map((item) => String(item).trim())
    .filter(Boolean);
}
