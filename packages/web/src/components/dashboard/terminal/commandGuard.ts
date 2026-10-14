/**
 * Accidental dangerous-command guard for web terminal.
 *
 * Provides client-side heuristic detection for high-impact accidental commands
 * (recursive root/system deletion, filesystem format, dd to raw disk, system reboot/poweroff,
 * and recursive permission changes on system roots).
 *
 * NOT an unprivileged sandbox or security boundary: the web terminal continues
 * to run as the configured user (e.g. root on host/VPS).
 * Caveat: Does not intercept commands from shell history, aliases, scripts, or fullscreen apps.
 */

export type CommandGuardDecision = {
  isDangerous: boolean;
  reason?: string;
  category?: "rm" | "mkfs" | "dd" | "shutdown" | "systemctl" | "permissions" | "forkbomb" | "redirection";
};

const CRITICAL_SYSTEM_DIRS = [
  "etc",
  "usr",
  "bin",
  "sbin",
  "boot",
  "dev",
  "lib",
  "lib64",
  "sys",
  "proc",
  "var",
  "root",
  "home",
] as const;

/**
 * Checks whether a path string points to root, current/parent directory, wildcard,
 * user home, or a top-level critical system directory (e.g. /etc, /usr, /bin).
 */
export function isDestructiveTarget(rawTarget: string): boolean {
  if (!rawTarget) return false;
  const target = rawTarget.replace(/^['"]|['"]$/g, "").trim();
  if (!target) return false;

  // Root representations: /, //, ///, /*, /*.*, /., /..
  if (/^\/+$/.test(target)) return true;
  if (/^\/\*+.*$/.test(target)) return true;
  if (target === "/." || target === "/..") return true;

  // Wildcard and relative destructive targets: ., ./*, .., ../*, *
  if (target === "." || target === "./*" || target === ".." || target === "../*" || target === "*") {
    return true;
  }

  // User home targets: ~, ~/*, $HOME, $HOME/*, ${HOME}, ${HOME}/*
  if (
    target === "~" ||
    target.startsWith("~/") ||
    target === "$HOME" ||
    target.startsWith("$HOME/") ||
    target === "${HOME}" ||
    target.startsWith("${HOME}/")
  ) {
    return true;
  }

  // Critical system root directories (e.g. /etc, /etc/, /etc/*, /usr, /usr/*)
  for (const dir of CRITICAL_SYSTEM_DIRS) {
    const prefix = `/${dir}`;
    if (
      target === prefix ||
      target === `${prefix}/` ||
      target === `${prefix}/*` ||
      target.startsWith(`${prefix}/*`)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Splits a line into command segments separated by shell operators (&&, ||, ;, |, &),
 * while respecting single and double quotes and backslash escapes.
 */
export function splitCommandSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;
  let heredocDelim: string | null = null;

  const lines = input.split("\n");
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];

    // If we are inside a heredoc, check if this line closes it
    if (heredocDelim !== null) {
      if (line.trim() === heredocDelim) {
        heredocDelim = null;
      }
      // heredoc content is never executed as a command
      continue;
    }

    // Check if this line starts a heredoc (e.g. <<EOF, <<'EOF', <<-EOF)
    const heredocMatch = line.match(/<<-?\s*['"]?([A-Za-z0-9_]+)['"]?/);
    if (heredocMatch) {
      heredocDelim = heredocMatch[1];
    }

    // Process the line for command separators
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (escape) {
        current += ch;
        escape = false;
        continue;
      }

      if (ch === "\\" && !inSingleQuote) {
        current += ch;
        escape = true;
        continue;
      }

      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += ch;
        continue;
      }

      if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote) {
        // Check for && or ||
        if (
          (ch === "&" && line[i + 1] === "&") ||
          (ch === "|" && line[i + 1] === "|")
        ) {
          if (current.trim()) segments.push(current.trim());
          current = "";
          i++; // skip second char
          continue;
        }

        // Check for ;, |
        if (ch === ";" || ch === "|") {
          if (current.trim()) segments.push(current.trim());
          current = "";
          continue;
        }

        // Standalone & (background operator, not redirection like 2>&1 or &>)
        if (ch === "&" && line[i + 1] !== ">" && (i === 0 || line[i - 1] !== ">")) {
          if (current.trim()) segments.push(current.trim());
          current = "";
          continue;
        }
      }

      current += ch;
    }

    // End of line acts as separator if outside quotes
    if (!inSingleQuote && !inDoubleQuote) {
      if (current.trim()) segments.push(current.trim());
      current = "";
    } else {
      current += "\n";
    }
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  // Extract subshell commands: $(...) and `...`
  const subshells: string[] = [];
  for (const seg of segments) {
    // Only look outside single quotes for subshells
    let inSQ = false;
    let segClean = "";
    for (let j = 0; j < seg.length; j++) {
      if (seg[j] === "'" && (j === 0 || seg[j - 1] !== "\\")) {
        inSQ = !inSQ;
        continue;
      }
      if (!inSQ) {
        segClean += seg[j];
      }
    }

    // Match $(...)
    const parenMatches = segClean.matchAll(/\$\(([^)]+)\)/g);
    for (const match of parenMatches) {
      if (match[1]?.trim()) {
        subshells.push(...splitCommandSegments(match[1].trim()));
      }
    }

    // Match `...`
    const backtickMatches = segClean.matchAll(/`([^`]+)`/g);
    for (const match of backtickMatches) {
      if (match[1]?.trim()) {
        subshells.push(...splitCommandSegments(match[1].trim()));
      }
    }
  }

  segments.push(...subshells);

  return segments;
}

/**
 * Splits a command segment into tokens, respecting quotes and escapes.
 */
export function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escape = false;
  let hasTokenChars = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escape) {
      current += ch;
      hasTokenChars = true;
      escape = false;
      continue;
    }

    if (ch === "\\" && !inSingleQuote) {
      escape = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      hasTokenChars = true;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      hasTokenChars = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(ch)) {
      if (hasTokenChars || current.length > 0) {
        tokens.push(current);
        current = "";
        hasTokenChars = false;
      }
      continue;
    }

    current += ch;
    hasTokenChars = true;
  }

  if (hasTokenChars || current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Strips environment variable assignments and command wrappers (sudo, doas, pkexec, etc.)
 * to locate the executable command and its effective arguments.
 */
function extractUnderlyingCommand(tokens: string[]): {
  cmd: string;
  args: string[];
} {
  let idx = 0;

  // 1. Skip environment variable assignments (e.g. FOO=bar)
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    idx++;
  }

  // 2. Loop to strip wrappers (e.g. sudo, doas, nohup, exec, env)
  while (idx < tokens.length) {
    const token = tokens[idx];

    if (token === "sudo") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (["-u", "-g", "-p", "-a", "-C", "-D", "-h", "-R", "-T", "-U"].includes(tokens[idx])) {
          idx += 2;
        } else if (tokens[idx] === "--") {
          idx++;
          break;
        } else {
          idx++;
        }
      }
      continue;
    }

    if (token === "doas") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (["-u", "-C"].includes(tokens[idx])) {
          idx += 2;
        } else if (tokens[idx] === "--") {
          idx++;
          break;
        } else {
          idx++;
        }
      }
      continue;
    }

    if (token === "pkexec") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (["--user"].includes(tokens[idx])) {
          idx += 2;
        } else {
          idx++;
        }
      }
      continue;
    }

    if (["nohup", "exec", "builtin", "command"].includes(token)) {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        idx++;
      }
      continue;
    }

    if (token === "time") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (["-o"].includes(tokens[idx])) {
          idx += 2;
        } else {
          idx++;
        }
      }
      continue;
    }

    if (token === "env") {
      idx++;
      while (idx < tokens.length) {
        if (tokens[idx].startsWith("-")) {
          if (["-u"].includes(tokens[idx])) idx += 2;
          else idx++;
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
          idx++;
        } else {
          break;
        }
      }
      continue;
    }

    break;
  }

  const rawCmd = tokens[idx] || "";
  const baseCmd = rawCmd.split("/").pop() || rawCmd;
  const args = tokens.slice(idx + 1);

  return { cmd: baseCmd, args };
}

/**
 * Checks a single command segment for destructive actions.
 */
export function isCommandSegmentDangerous(segment: string): CommandGuardDecision {
  const trimmed = segment.trim();
  if (!trimmed) return { isDangerous: false };

  // 1. Fork bomb pattern
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(trimmed)) {
    return {
      isDangerous: true,
      category: "forkbomb",
      reason: "Shell fork bomb detected",
    };
  }

  // 2. Destructive raw disk redirection: e.g. > /dev/sda (unquoted only)
  if (hasUnquotedRawDiskRedirection(trimmed)) {
    return {
      isDangerous: true,
      category: "redirection",
      reason: "Direct output redirection to raw block device",
    };
  }

  // Tokenize the segment
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) return { isDangerous: false };

  const { cmd, args } = extractUnderlyingCommand(tokens);
  if (!cmd) return { isDangerous: false };

  // 3. Nested shell invocations: bash -c "..." or sh -c "..."
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(cmd)) {
    const cIndex = args.indexOf("-c");
    if (cIndex !== -1 && args[cIndex + 1]) {
      const subDecision = scanTextForDanger(args[cIndex + 1]);
      if (subDecision.isDangerous) {
        return subDecision;
      }
    }
  }

  // 4. System reboot, shutdown, poweroff, halt
  if (["reboot", "poweroff", "halt"].includes(cmd)) {
    if (args.includes("--help")) return { isDangerous: false };
    return {
      isDangerous: true,
      category: "shutdown",
      reason: `System ${cmd} command`,
    };
  }

  if (cmd === "shutdown") {
    if (args.includes("-c") || args.includes("--cancel") || args.includes("--help")) {
      return { isDangerous: false };
    }
    return {
      isDangerous: true,
      category: "shutdown",
      reason: "System shutdown command",
    };
  }

  if (cmd === "init" || cmd === "telinit") {
    if (args.includes("0")) {
      return {
        isDangerous: true,
        category: "shutdown",
        reason: "System halt (init 0)",
      };
    }
    if (args.includes("6")) {
      return {
        isDangerous: true,
        category: "shutdown",
        reason: "System reboot (init 6)",
      };
    }
  }

  // 5. systemctl reboot / poweroff / halt
  if (cmd === "systemctl") {
    const subcmd = args.find((a) => !a.startsWith("-"));
    if (
      subcmd &&
      ["reboot", "poweroff", "halt", "emergency", "rescue", "kexec"].includes(subcmd)
    ) {
      return {
        isDangerous: true,
        category: "systemctl",
        reason: `systemctl ${subcmd} command`,
      };
    }
  }

  // 6. Filesystem format: mkfs and variants
  if (cmd.startsWith("mkfs") || cmd === "mke2fs") {
    if (args.includes("--help") || args.includes("-V") || args.includes("--version")) {
      return { isDangerous: false };
    }
    return {
      isDangerous: true,
      category: "mkfs",
      reason: `Filesystem format command (${cmd})`,
    };
  }

  // 7. dd to raw output device
  if (cmd === "dd") {
    for (const arg of args) {
      if (arg.startsWith("of=")) {
        const out = arg.slice(3).replace(/^['"]|['"]$/g, "");
        // Destructive disk / block devices
        if (
          /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|nvme[0-9]|xvd[a-z]|mmcblk[0-9]|mapper\/|disk\/|root)/i.test(
            out,
          )
        ) {
          return {
            isDangerous: true,
            category: "dd",
            reason: `dd write to raw device (${out})`,
          };
        }
        if (out === "/dev/mem" || out === "/dev/kmem" || out === "/dev/port") {
          return {
            isDangerous: true,
            category: "dd",
            reason: `dd write to kernel device (${out})`,
          };
        }
      }
    }
  }

  // 8. rm destructive targets and recursive force
  if (cmd === "rm") {
    let isRecursive = false;
    let isForce = false;
    const targets: string[] = [];
    let pastFlags = false;

    for (const arg of args) {
      if (pastFlags) {
        targets.push(arg);
        continue;
      }
      if (arg === "--") {
        pastFlags = true;
        continue;
      }
      if (arg.startsWith("--")) {
        if (arg === "--recursive") isRecursive = true;
        if (arg === "--force") isForce = true;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        const flags = arg.slice(1);
        if (flags.includes("r") || flags.includes("R")) isRecursive = true;
        if (flags.includes("f")) isForce = true;
        continue;
      }
      targets.push(arg);
    }

    for (const target of targets) {
      const clean = target.replace(/^['"]|['"]$/g, "").trim();
      // Bare rm targeting root or /* is always destructive
      if (clean === "/" || /^\/+$/.test(clean) || clean === "/*") {
        return {
          isDangerous: true,
          category: "rm",
          reason: `Deletion of root directory target (${clean})`,
        };
      }
      // Recursive rm against destructive target
      if (isRecursive && isDestructiveTarget(target)) {
        return {
          isDangerous: true,
          category: "rm",
          reason: `Recursive deletion of destructive target (${clean})`,
        };
      }
    }
  }

  // 9. Dangerous chmod / chown / chgrp on system paths
  if (["chmod", "chown", "chgrp"].includes(cmd)) {
    let isRecursive = false;
    const nonFlags: string[] = [];

    for (const arg of args) {
      if (
        arg === "-R" ||
        arg === "--recursive" ||
        (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--") && arg.includes("R"))
      ) {
        isRecursive = true;
      } else if (!arg.startsWith("-")) {
        nonFlags.push(arg);
      }
    }

    // For chmod: first nonFlag is mode (e.g. 777), rest are targets.
    // For chown/chgrp: first nonFlag is owner:group, rest are targets.
    const modeOrOwner = nonFlags[0] || "";
    const targets = nonFlags.slice(1);

    if (cmd === "chmod") {
      // Destructive chmod 777 / or chmod 000 /
      if (
        ["777", "000", "a+rwx", "0777", "0000"].includes(modeOrOwner) &&
        (targets.includes("/") || nonFlags.includes("/"))
      ) {
        return {
          isDangerous: true,
          category: "permissions",
          reason: `Destructive permissions on root directory (${modeOrOwner})`,
        };
      }
    }

    if (isRecursive) {
      for (const target of targets) {
        if (isDestructiveTarget(target)) {
          return {
            isDangerous: true,
            category: "permissions",
            reason: `Recursive ${cmd} on system path (${target})`,
          };
        }
      }
    }
  }

  return { isDangerous: false };
}

/**
 * Scans a full text payload (single-line or multiline paste/input) for any dangerous commands.
 */
export function scanTextForDanger(text: string): CommandGuardDecision {
  if (!text) return { isDangerous: false };

  const segments = splitCommandSegments(text);
  for (const segment of segments) {
    const decision = isCommandSegmentDangerous(segment);
    if (decision.isDangerous) {
      return decision;
    }
  }

  return { isDangerous: false };
}

/**
 * Detects unquoted output redirection targeting raw block devices (e.g., > /dev/sda).
 * Harmless commands with quoted redirections (e.g. echo '> /dev/sda') are preserved.
 */
export function hasUnquotedRawDiskRedirection(input: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && ch === ">") {
      let j = i + 1;
      while (
        j < input.length &&
        (input[j] === ">" || input[j] === "|" || input[j] === "&" || input[j] === " ")
      ) {
        j++;
      }
      const remainder = input.slice(j);
      if (
        /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|nvme[0-9]|mmcblk[0-9]|mapper\/|disk\/|root)/i.test(
          remainder,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Splits a raw terminal input chunk from xterm onData into atomic units:
 * - CRLF / CR / LF newlines
 * - CSI / SS3 / two-char escape sequences
 * - Control characters
 * - Contiguous Unicode text runs (including supplementary code points / emoji)
 */
export function splitTerminalInputChunks(data: string): string[] {
  if (!data) return [];
  const chunks: string[] = [];
  const pattern =
    /(\r\n|\r|\n|\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b.|\x1b|[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f]|[^\r\n\x00-\x1f\x7f]+)/gu;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    if (match[0]) {
      chunks.push(match[0]);
    }
  }

  if (chunks.length === 0 && data.length > 0) {
    chunks.push(data);
  }

  return chunks;
}

/**
 * Checks whether a single command line or expression contains a dangerous command.
 */
export function isCommandDangerous(command: string): CommandGuardDecision {
  return scanTextForDanger(command);
}

export type TrackerInputResult =
  | { type: "enter"; line: string; valid: boolean }
  | { type: "ctrl_u" }
  | { type: "ctrl_c" }
  | { type: "edit" }
  | { type: "invalidated" };

/**
 * Pure helper tracking common line-input edits, cursor position, backspace, and line cancellations.
 * Invalids tracking when shell history, tab completion, or unknown control sequences are encountered
 * to avoid breaking ordinary interactive or fullscreen input.
 */
export class TerminalLineTracker {
  private buffer = "";
  private cursor = 0;
  private valid = true;

  reset(): void {
    this.buffer = "";
    this.cursor = 0;
    this.valid = true;
  }

  invalidate(): void {
    this.valid = false;
  }

  isValid(): boolean {
    return this.valid;
  }

  setBuffer(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
    this.valid = true;
  }

  getBuffer(): string {
    return this.buffer;
  }

  getCursor(): number {
    return this.cursor;
  }
  /**
   * Feeds a keystroke or input chunk, updating tracker state.
   * If Enter is detected, checks for dangerous commands, resets the buffer,
   * and returns the decision.
   */
  feed(data: string): {
    isEnter: boolean;
    isDangerous: boolean;
    reason?: string;
    command: string;
  } {
    const inputResult = this.handleInput(data);
    if (inputResult.type === "enter") {
      if (!inputResult.valid) {
        this.reset();
        return {
          isEnter: true,
          isDangerous: false,
          command: inputResult.line,
        };
      }
      const check = isCommandDangerous(inputResult.line);
      this.reset();
      return {
        isEnter: true,
        isDangerous: check.isDangerous,
        reason: check.reason,
        command: inputResult.line,
      };
    }
    return {
      isEnter: false,
      isDangerous: false,
      command: this.buffer,
    };
  }

  /**
   * Processes a chunk of input data from xterm's onData.
   */
  handleInput(data: string): TrackerInputResult {
    // 1. Enter key (\r, \n, or compound containing \r)
    if (data.includes("\r") || data.includes("\n")) {
      const parts = data.split(/[\r\n]/);
      if (parts[0]) {
        // Feed the prefix characters before Enter
        this.applyKeystroke(parts[0]);
      }
      const line = this.buffer;
      const valid = this.valid;
      return { type: "enter", line, valid };
    }

    // 2. Ctrl+C (\u0003) - Shell line cancel
    if (data === "\x03") {
      this.reset();
      return { type: "ctrl_c" };
    }

    // 3. Ctrl+U (\u0015) - Line rubout
    if (data === "\x15") {
      this.buffer = "";
      this.cursor = 0;
      this.valid = true;
      return { type: "ctrl_u" };
    }

    // 4. Backspace (\x7f or \x08)
    if (data === "\x7f" || data === "\x08") {
      if (this.valid && this.cursor > 0) {
        this.buffer =
          this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
      }
      return { type: "edit" };
    }

    // 5. Delete key (\x1b[3~)
    if (data === "\x1b[3~") {
      if (this.valid && this.cursor < this.buffer.length) {
        this.buffer =
          this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
      }
      return { type: "edit" };
    }

    // 6. Cursor navigation
    // Left arrow (\x1b[D)
    if (data === "\x1b[D" || data === "\x1bOD") {
      if (this.cursor > 0) this.cursor--;
      return { type: "edit" };
    }
    // Right arrow (\x1b[C or \x1bOC)
    if (data === "\x1b[C" || data === "\x1bOC") {
      if (this.cursor < this.buffer.length) this.cursor++;
      return { type: "edit" };
    }
    // Home (\x1b[H, \x1b[1~, \x1bOH, \x01 / Ctrl+A)
    if (
      data === "\x1b[H" ||
      data === "\x1b[1~" ||
      data === "\x1bOH" ||
      data === "\x01"
    ) {
      this.cursor = 0;
      return { type: "edit" };
    }
    // End (\x1b[F, \x1b[4~, \x1bOF, \x05 / Ctrl+E)
    if (
      data === "\x1b[F" ||
      data === "\x1b[4~" ||
      data === "\x1bOF" ||
      data === "\x05"
    ) {
      this.cursor = this.buffer.length;
      return { type: "edit" };
    }
    // Ctrl+K (\x0b): Kill to end of line
    if (data === "\x0b") {
      if (this.valid) {
        this.buffer = this.buffer.slice(0, this.cursor);
      }
      return { type: "edit" };
    }
    // Ctrl+W (\x17): Word rubout
    if (data === "\x17") {
      if (this.valid && this.cursor > 0) {
        let pos = this.cursor;
        while (pos > 0 && this.buffer[pos - 1] === " ") pos--;
        while (pos > 0 && this.buffer[pos - 1] !== " ") pos--;
        this.buffer = this.buffer.slice(0, pos) + this.buffer.slice(this.cursor);
        this.cursor = pos;
      }
      return { type: "edit" };
    }

    // 7. Invalidation sequences: Up/Down arrow (history), Tab (completion), Ctrl+R, or unknown escapes
    if (
      data === "\x1b[A" || // Up arrow
      data === "\x1b[B" || // Down arrow
      data === "\t" || // Tab completion
      data === "\x12" || // Ctrl+R
      data.startsWith("\x1b") || // Other escape sequences
      /[\x00-\x07\x0e-\x14\x16\x18-\x1a\x1c-\x1f]/.test(data) // Other control characters
    ) {
      this.invalidate();
      return { type: "invalidated" };
    }

    // 8. Regular printable characters
    this.applyKeystroke(data);
    return { type: "edit" };
  }

  private applyKeystroke(str: string): void {
    if (!this.valid) return;
    this.buffer =
      this.buffer.slice(0, this.cursor) + str + this.buffer.slice(this.cursor);
    this.cursor += str.length;
  }
}
