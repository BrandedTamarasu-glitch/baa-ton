/** Advisory shell guard, not a shell sandbox. Only exact standalone diagnostic
 * invocations receive an exception to the direct-Pi-launch prohibition. */
export function isReadOnlyPiDiagnostic(command: string): boolean {
  // No shell expansion, redirection, quoting, comments, compound commands or jobs.
  if (!/^[-a-zA-Z0-9_./:= \t]+$/.test(command.trim())) return false;
  const words = command.trim().split(/[ \t]+/);
  if (words.shift() !== "pi") return false;
  if (
    words.length === 1 &&
    ["--help", "-h", "--version", "-v"].includes(words[0])
  )
    return true;
  if (words[0] === "--offline") words.shift();
  if (words[0] === "--list-models")
    return (
      words.length === 1 ||
      (words.length === 2 && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(words[1]))
    );
  if (words.shift() !== "auth" || words.shift() !== "check") return false;
  let identity = false;
  const seen = new Set<string>();
  while (words.length) {
    const flag = words.shift()!;
    if (seen.has(flag)) return false;
    seen.add(flag);
    if (["--json", "--no-refresh"].includes(flag)) continue;
    if (!["--provider", "--model"].includes(flag)) return false;
    const value = words.shift();
    if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(value)) return false;
    identity = true;
  }
  // No credential output or implicit OAuth refresh in an inspection exception.
  return identity && seen.has("--no-refresh");
}

export function blocksUnmanagedAgentCommand(command: string): boolean {
  if (isReadOnlyPiDiagnostic(command)) return false;
  return (
    /(?:^|[;&|\n]\s*)\s*pi(?:\s|$)/m.test(command) ||
    /(?:^|[;&|\n]\s*)\s*pi-(?:subagents|background-tasks)(?:\s|$)/m.test(
      command,
    ) ||
    /(?:^|[;&\n]\s*)\s*(?:nohup|disown)\b/m.test(command)
  );
}
