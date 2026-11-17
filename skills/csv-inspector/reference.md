# Reference

`inspect.mjs` reads newline-delimited JSON from stdin, sorts out an explicitly
provided `.csv` material, and writes `csv-summary.json` under the artifact
directory. It never globs directories and never runs shell commands.
