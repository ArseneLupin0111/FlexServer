import { describe, expect, it } from "vitest";
import {
  hasUnquotedRawDiskRedirection,
  isCommandDangerous,
  scanTextForDanger,
  splitCommandSegments,
  splitTerminalInputChunks,
  TerminalLineTracker,
  tokenizeCommand,
} from "./commandGuard";

describe("splitCommandSegments", () => {
  it("splits simple chained commands by semicolon, ampersand, and pipe", () => {
    expect(splitCommandSegments("echo 1; echo 2 && echo 3 || echo 4 | cat")).toEqual([
      "echo 1",
      "echo 2",
      "echo 3",
      "echo 4",
      "cat",
    ]);
  });

  it("preserves separators within single and double quotes", () => {
    expect(
      splitCommandSegments("echo 'hello; world' && echo \"foo && bar\""),
    ).toEqual(["echo 'hello; world'", 'echo "foo && bar"']);
  });

  it("extracts subshells and command substitutions as distinct segments", () => {
    const segments = splitCommandSegments("echo $(rm -rf /) && echo `reboot`");
    expect(segments).toContain("rm -rf /");
    expect(segments).toContain("reboot");
  });
});

describe("tokenizeCommand", () => {
  it("parses words and strips quotes correctly", () => {
    const tokens = tokenizeCommand('rm -rf "/var/log" \'test file.txt\'');
    expect(tokens).toEqual(["rm", "-rf", "/var/log", "test file.txt"]);
  });

  it("handles backslash escapes", () => {
    const tokens = tokenizeCommand("echo hello\\ world next");
    expect(tokens).toEqual(["echo", "hello world", "next"]);
  });
});

describe("isCommandDangerous", () => {
  describe("rm commands", () => {
    it("flags recursive deletion of root and critical system directories", () => {
      expect(isCommandDangerous("rm -rf /").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -fr /").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -r -f /").isDangerous).toBe(true);
      expect(isCommandDangerous("rm --recursive --force /").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf /*").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf /etc").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf /usr").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf /var").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf ~").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf $HOME").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf .").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf ./*").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf ..").isDangerous).toBe(true);
      expect(isCommandDangerous("rm -rf ../*").isDangerous).toBe(true);
    });

    it("flags non-recursive deletion directly targeting root or wildcard root", () => {
      expect(isCommandDangerous("rm /").isDangerous).toBe(true);
      expect(isCommandDangerous("rm /*").isDangerous).toBe(true);
    });

    it("allows safe non-critical rm commands", () => {
      expect(isCommandDangerous("rm file.txt").isDangerous).toBe(false);
      expect(isCommandDangerous("rm -f /tmp/test.log").isDangerous).toBe(false);
      expect(isCommandDangerous("rm -rf ./node_modules").isDangerous).toBe(false);
      expect(isCommandDangerous("rm -r my-project/build").isDangerous).toBe(false);
      expect(isCommandDangerous("rm --help").isDangerous).toBe(false);
    });
  });

  describe("filesystem formatting (mkfs)", () => {
    it("flags mkfs variants on disk devices", () => {
      expect(isCommandDangerous("mkfs /dev/sda1").isDangerous).toBe(true);
      expect(isCommandDangerous("mkfs.ext4 /dev/nvme0n1p1").isDangerous).toBe(true);
      expect(isCommandDangerous("mkfs.xfs -f /dev/vda").isDangerous).toBe(true);
      expect(isCommandDangerous("mke2fs /dev/sdb").isDangerous).toBe(true);
    });

    it("allows safe help queries", () => {
      expect(isCommandDangerous("mkfs --help").isDangerous).toBe(false);
      expect(isCommandDangerous("mkfs -V").isDangerous).toBe(false);
    });
  });

  describe("raw disk writes (dd)", () => {
    it("flags dd writes to physical block devices", () => {
      expect(isCommandDangerous("dd if=/dev/zero of=/dev/sda").isDangerous).toBe(true);
      expect(isCommandDangerous("dd if=/dev/urandom of=/dev/nvme0n1 bs=1M").isDangerous).toBe(true);
      expect(isCommandDangerous("dd if=image.iso of=/dev/vda").isDangerous).toBe(true);
    });

    it("allows safe dd usage targeting files or /dev/null", () => {
      expect(isCommandDangerous("dd if=/dev/zero of=testfile.img bs=1M count=10").isDangerous).toBe(false);
      expect(isCommandDangerous("dd if=/dev/sda of=/dev/null").isDangerous).toBe(false);
      expect(isCommandDangerous("dd --help").isDangerous).toBe(false);
    });
  });

  describe("system shutdown and reboot", () => {
    it("flags direct shutdown, reboot, poweroff, and halt", () => {
      expect(isCommandDangerous("reboot").isDangerous).toBe(true);
      expect(isCommandDangerous("poweroff").isDangerous).toBe(true);
      expect(isCommandDangerous("halt").isDangerous).toBe(true);
      expect(isCommandDangerous("shutdown -h now").isDangerous).toBe(true);
      expect(isCommandDangerous("shutdown -r now").isDangerous).toBe(true);
      expect(isCommandDangerous("shutdown 0").isDangerous).toBe(true);
      expect(isCommandDangerous("init 0").isDangerous).toBe(true);
      expect(isCommandDangerous("init 6").isDangerous).toBe(true);
      expect(isCommandDangerous("telinit 0").isDangerous).toBe(true);
      expect(isCommandDangerous("telinit 6").isDangerous).toBe(true);
    });

    it("flags systemctl shutdown/reboot subcommands", () => {
      expect(isCommandDangerous("systemctl reboot").isDangerous).toBe(true);
      expect(isCommandDangerous("systemctl poweroff").isDangerous).toBe(true);
      expect(isCommandDangerous("systemctl halt").isDangerous).toBe(true);
      expect(isCommandDangerous("systemctl emergency").isDangerous).toBe(true);
    });

    it("allows safe shutdown cancels, help, and standard systemctl service ops", () => {
      expect(isCommandDangerous("shutdown -c").isDangerous).toBe(false);
      expect(isCommandDangerous("shutdown --help").isDangerous).toBe(false);
      expect(isCommandDangerous("reboot --help").isDangerous).toBe(false);
      expect(isCommandDangerous("systemctl status nginx").isDangerous).toBe(false);
      expect(isCommandDangerous("systemctl restart docker").isDangerous).toBe(false);
    });
  });

  describe("permissions and ownership changes (chmod/chown)", () => {
    it("flags recursive permission resets on root and critical system paths", () => {
      expect(isCommandDangerous("chmod -R 777 /").isDangerous).toBe(true);
      expect(isCommandDangerous("chmod -R 000 /etc").isDangerous).toBe(true);
      expect(isCommandDangerous("chmod --recursive 777 /var").isDangerous).toBe(true);
      expect(isCommandDangerous("chown -R root:root /").isDangerous).toBe(true);
      expect(isCommandDangerous("chown --recursive www-data /usr").isDangerous).toBe(true);
    });

    it("flags non-recursive root permission zeroing", () => {
      expect(isCommandDangerous("chmod 000 /").isDangerous).toBe(true);
      expect(isCommandDangerous("chmod 777 /").isDangerous).toBe(true);
    });

    it("allows normal project permission changes", () => {
      expect(isCommandDangerous("chmod +x script.sh").isDangerous).toBe(false);
      expect(isCommandDangerous("chmod 644 ./config.json").isDangerous).toBe(false);
      expect(isCommandDangerous("chmod -R 755 ./dist").isDangerous).toBe(false);
      expect(isCommandDangerous("chown -R deploy:deploy ./app").isDangerous).toBe(false);
    });
  });

  describe("command wrappers and prefix stripping", () => {
    it("detects dangerous commands wrapped in sudo, doas, env, nohup", () => {
      expect(isCommandDangerous("sudo rm -rf /").isDangerous).toBe(true);
      expect(isCommandDangerous("sudo -u admin reboot").isDangerous).toBe(true);
      expect(isCommandDangerous("doas poweroff").isDangerous).toBe(true);
      expect(isCommandDangerous("nohup reboot &").isDangerous).toBe(true);
      expect(isCommandDangerous("env FOO=BAR mkfs /dev/sda1").isDangerous).toBe(true);
      expect(isCommandDangerous("VAR=1 sudo rm -rf /etc").isDangerous).toBe(true);
    });

    it("detects dangerous commands executed via sh -c or bash -c", () => {
      expect(isCommandDangerous("bash -c 'rm -rf /'").isDangerous).toBe(true);
      expect(isCommandDangerous('sh -c "reboot"').isDangerous).toBe(true);
      expect(isCommandDangerous("bash -c 'echo safe'").isDangerous).toBe(false);
    });
  });

  describe("non-blocked commands and false positive avoidance", () => {
    it("does not block echo or cat containing dangerous words", () => {
      expect(isCommandDangerous("echo 'reboot'").isDangerous).toBe(false);
      expect(isCommandDangerous("echo \"rm -rf /\"").isDangerous).toBe(false);
      expect(isCommandDangerous("cat <<EOF\nreboot\nEOF").isDangerous).toBe(false);
      expect(isCommandDangerous("grep 'shutdown' /var/log/syslog").isDangerous).toBe(false);
    });

    it("does not block safe common commands", () => {
      expect(isCommandDangerous("ls -la /").isDangerous).toBe(false);
      expect(isCommandDangerous("cd /etc && ls").isDangerous).toBe(false);
      expect(isCommandDangerous("cat /etc/hosts").isDangerous).toBe(false);
      expect(isCommandDangerous("git commit -m 'reboot fix'").isDangerous).toBe(false);
      expect(isCommandDangerous("npm run build").isDangerous).toBe(false);
    });
  });
});

describe("scanTextForDanger", () => {
  it("detects dangerous commands across multiline text", () => {
    const text = "echo 'starting maintenance'\nls -la\nrm -rf /\necho 'done'";
    const result = scanTextForDanger(text);
    expect(result.isDangerous).toBe(true);
    expect(result.reason).toContain("/");
  });

  it("passes safe multiline text", () => {
    const text = "git status\ngit add .\ngit commit -m 'update'\ngit push";
    expect(scanTextForDanger(text).isDangerous).toBe(false);
  });
});

describe("TerminalLineTracker", () => {
  it("tracks typed printable characters and returns danger on Enter", () => {
    const tracker = new TerminalLineTracker();
    for (const ch of "rm -rf /") {
      tracker.feed(ch);
    }
    expect(tracker.getBuffer()).toBe("rm -rf /");

    const result = tracker.feed("\r");
    expect(result.isEnter).toBe(true);
    expect(result.isDangerous).toBe(true);
    expect(tracker.getBuffer()).toBe(""); // Reset after enter
  });

  it("allows safe commands on Enter", () => {
    const tracker = new TerminalLineTracker();
    for (const ch of "ls -la") {
      tracker.feed(ch);
    }
    const result = tracker.feed("\r");
    expect(result.isEnter).toBe(true);
    expect(result.isDangerous).toBe(false);
  });

  it("handles backspace line editing", () => {
    const tracker = new TerminalLineTracker();
    for (const ch of "reboott") {
      tracker.feed(ch);
    }
    expect(tracker.getBuffer()).toBe("reboott");
    tracker.feed("\x7f"); // Backspace
    expect(tracker.getBuffer()).toBe("reboot");

    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(true);
  });

  it("handles Ctrl+U (line erase)", () => {
    const tracker = new TerminalLineTracker();
    for (const ch of "rm -rf /") {
      tracker.feed(ch);
    }
    tracker.feed("\x15"); // Ctrl+U
    expect(tracker.getBuffer()).toBe("");

    for (const ch of "ls") {
      tracker.feed(ch);
    }
    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(false);
  });

  it("handles Ctrl+C (cancel line)", () => {
    const tracker = new TerminalLineTracker();
    for (const ch of "rm -rf /") {
      tracker.feed(ch);
    }
    tracker.feed("\x03"); // Ctrl+C
    expect(tracker.getBuffer()).toBe("");

    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(false);
  });

  it("invalidates tracking on shell history recall (escape sequences) so interactive input does not break", () => {
    const tracker = new TerminalLineTracker();
    tracker.feed("\x1b");
    tracker.feed("[");
    tracker.feed("A"); // Up arrow
    expect(tracker.isValid()).toBe(false);

    // On Enter, invalidated tracker lets input pass safely
    const result = tracker.feed("\r");
    expect(result.isEnter).toBe(true);
    expect(result.isDangerous).toBe(false);
    expect(tracker.isValid()).toBe(true); // Resets after enter
  });

  it("invalidates tracking on Tab (auto-completion)", () => {
    const tracker = new TerminalLineTracker();
    for (const ch of "rm -r") {
      tracker.feed(ch);
    }
    tracker.feed("\t");
    expect(tracker.isValid()).toBe(false);
    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(false);
  });

  it("handles cursor movements with Home, End, and left/right arrows", () => {
    const tracker = new TerminalLineTracker();
    tracker.feed("b");
    tracker.feed("o");
    tracker.feed("o");
    tracker.feed("t");
    // Ctrl+A to go to start
    tracker.feed("\x01");
    expect(tracker.getCursor()).toBe(0);
    // Type "re" at start
    tracker.feed("r");
    tracker.feed("e");
    expect(tracker.getBuffer()).toBe("reboot");
    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(true);
  });

  it("supports left/right arrow escapes without invalidating tracking", () => {
    const tracker = new TerminalLineTracker();
    tracker.feed("reboxt");
    // Move cursor left by 2 positions using intact escape chunks
    tracker.feed("\x1b[D");
    tracker.feed("\x1b[D");
    expect(tracker.isValid()).toBe(true);
    expect(tracker.getCursor()).toBe(4);
    // Delete the 'x'
    tracker.feed("\x1b[3~");
    expect(tracker.getBuffer()).toBe("rebot");
    // Insert 'o'
    tracker.feed("o");
    expect(tracker.getBuffer()).toBe("reboot");
    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(true);
  });

  it("supports setBuffer to restore trailing unterminated multiline paste", () => {
    const tracker = new TerminalLineTracker();
    tracker.setBuffer("rm -rf ");
    expect(tracker.getBuffer()).toBe("rm -rf ");
    expect(tracker.getCursor()).toBe(7);
    tracker.feed("/");
    expect(tracker.getBuffer()).toBe("rm -rf /");
    const result = tracker.feed("\r");
    expect(result.isDangerous).toBe(true);
  });
});

describe("splitTerminalInputChunks", () => {
  it("splits escape sequences as intact atomic units", () => {
    const chunks = splitTerminalInputChunks("\x1b[D\x1b[3~\x1bOA");
    expect(chunks).toEqual(["\x1b[D", "\x1b[3~", "\x1bOA"]);
  });

  it("preserves multi-byte Unicode and emoji code points without splitting surrogates", () => {
    const chunks = splitTerminalInputChunks("deploy 🚀 server\r");
    expect(chunks).toEqual(["deploy 🚀 server", "\r"]);
  });

  it("splits newlines and text appropriately", () => {
    const chunks = splitTerminalInputChunks("echo hi\r\necho bye\n");
    expect(chunks).toEqual(["echo hi", "\r\n", "echo bye", "\n"]);
  });
});

describe("hasUnquotedRawDiskRedirection", () => {
  it("returns true for direct unquoted redirection to raw block devices", () => {
    expect(hasUnquotedRawDiskRedirection("cat image.iso > /dev/sda")).toBe(true);
    expect(hasUnquotedRawDiskRedirection("echo zero > /dev/nvme0n1")).toBe(true);
    expect(hasUnquotedRawDiskRedirection("backup >> /dev/mapper/rootvg")).toBe(true);
  });

  it("returns false for quoted redirection strings", () => {
    expect(hasUnquotedRawDiskRedirection("echo '> /dev/sda'")).toBe(false);
    expect(hasUnquotedRawDiskRedirection('echo "> /dev/sda"')).toBe(false);
    expect(hasUnquotedRawDiskRedirection("printf '%s\\n' '> /dev/sda1'")).toBe(false);
  });

  it("returns false for safe redirections", () => {
    expect(hasUnquotedRawDiskRedirection("ls -la > output.txt")).toBe(false);
    expect(hasUnquotedRawDiskRedirection("curl http://example.com > /dev/null")).toBe(false);
  });

  it("does not block echo '> /dev/sda' in isCommandDangerous", () => {
    expect(isCommandDangerous("echo '> /dev/sda'").isDangerous).toBe(false);
    expect(isCommandDangerous("cat disk.img > /dev/sda").isDangerous).toBe(true);
  });
});
