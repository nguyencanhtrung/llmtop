#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir, defaultConfigPath, loadConfig, ROOT } from "../src/config.mjs";
import { localTime } from "../src/format.mjs";
import { pricesCommand } from "../src/prices-command.mjs";
import { stopCommand, writeServerState } from "../src/process.mjs";
import { scan, scanReport } from "../src/scan.mjs";
import { serve } from "../src/serve.mjs";
import { show } from "../src/show.mjs";
import { uninstallCommand } from "../src/uninstall.mjs";
import { updateCommand } from "../src/update.mjs";
import { usageCommand } from "../src/usage-command.mjs";

const { version: VERSION } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const USAGE = `usage: llmtop <command> [options]

  scan                                  archive new transcript lines and ingest them
  show <session>:<line>                 print one archived record
  usage [--days n | --since d --until d] [--by day|model|provider|effort|project|session|hour|tool|skill|subagent]
        [--provider name] [--project name] [--model family] [--effort level]
  prices                                the price table checked against the host's cost records
  serve [--port n]                      the built dashboard on http://localhost:<port>
  stop                                  stop the running llmtop serve process
  update [--check] [--force]            check npmjs or upgrade llmtop to the latest version
  uninstall [--purge] [--dry-run] [--yes]
                                        stop llmtop and remove the global installation

Options:
  -h, --help                            show this help message
  -v, --version                         show version (${VERSION})

Listing commands and update --check accept --json. Config and data default to ~/.config/llmtop
(override with LLMTOP_CONFIG and LLMTOP_DATA).`;

function loadConfigOrDefault() {
  try {
    return loadConfig();
  } catch {
    return {
      configPath: defaultConfigPath(),
      data: process.env.LLMTOP_DATA || join(defaultConfigDir(), "data"),
      providers: {},
    };
  }
}

const COMMANDS = {
  async scan({ config, out }) {
    const t = await scan(config);
    reportScan(t, out);
    return t.prices.errors.length ? 1 : 0;
  },
  async show({ config, positional, out }) {
    out.write(`${await show(config, positional[0])}\n`);
  },
  usage: usageCommand,
  async serve({ config, options, out }) {
    const port = options.port === undefined ? config.port : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port needs a port number, got ${options.port}`);
    const at = localTime(config.timeZone);
    const server = await serve(config, { port, onScan: (t) => reportScan(t, out, `${at(new Date().toISOString())}  `) });
    const cleanup = writeServerState(config, { pid: process.pid, port: server.address().port, version: VERSION });
    server.once("close", cleanup);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      cleanup();
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    out.write(`dashboard at http://localhost:${server.address().port}: its Refresh button scans again, Ctrl+C to stop\n`);
  },
  prices: pricesCommand,
  stop: stopCommand,
  update: updateCommand,
  uninstall: uninstallCommand,
};

// Options are --name value or --flag; FLAGS lists the ones without a value.
const FLAGS = new Set(["json", "check", "force", "purge", "dry-run", "yes"]);
const LENIENT_CONFIG_COMMANDS = new Set(["stop", "update", "uninstall"]);
function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-y") {
      options.yes = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (FLAGS.has(name)) options[name] = true;
    else if (i + 1 < argv.length) options[name] = argv[++i];
    else throw new UsageError(`option --${name} needs a value`);
  }
  return { positional, options };
}

class UsageError extends Error {}

function reportScan(t, out, prefix = "") {
  const { lines, errors } = scanReport(t);
  for (const l of lines) out.write(`${prefix}${l}\n`);
  for (const e of errors) process.stderr.write(`${prefix}${e}\n`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(`${command ? `unknown command: ${command}\n\n` : ""}${USAGE}\n`);
    return 2;
  }
  const { positional, options } = parseArgs(rest);
  const config = LENIENT_CONFIG_COMMANDS.has(command) ? loadConfigOrDefault() : loadConfig();
  return (await run({ config, positional, options, out: process.stdout })) ?? 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err instanceof UsageError ? `${err.message}\n\n${USAGE}` : `error: ${err.message}`}\n`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
