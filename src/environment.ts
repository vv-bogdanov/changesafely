const allowedEnvironmentKeys = [
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "CODEX_CI",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

export function safeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
  for (const key of allowedEnvironmentKeys) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  delete result.NODE_TEST_CONTEXT;
  return result;
}
