/**
 * Typed errors. Every failure that crosses a public boundary has a stable code
 * so CLI/MCP/SDK callers can distinguish invalid config, selector output,
 * pending decisions and execution failures without matching message text.
 */
export class ConductorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export class ConfigError extends ConductorError {
  constructor(message, details) {
    super('invalid_config', message, details);
  }
}

export class CatalogError extends ConductorError {
  constructor(message, details) {
    super('catalog_error', message, details);
  }
}

export class MaterialError extends ConductorError {
  constructor(message, details) {
    super('material_error', message, details);
  }
}

export class SelectorError extends ConductorError {
  constructor(message, details) {
    super('invalid_selection', message, details);
  }
}

export class DecisionError extends ConductorError {
  constructor(code, message, details) {
    super(code, message, details);
  }
}

export class ExecutionError extends ConductorError {
  constructor(message, details) {
    super('execution_error', message, details);
  }
}

export class ProtocolError extends ConductorError {
  constructor(message, details) {
    super('protocol_error', message, details);
  }
}

/** Convert unknown thrown values into a serialisable error object. */
export function toErrorObject(error) {
  if (error instanceof ConductorError) return error.toJSON();
  if (error instanceof Error) {
    return { name: error.name, code: error.code || 'error', message: error.message };
  }
  return { name: 'Error', code: 'error', message: String(error) };
}
