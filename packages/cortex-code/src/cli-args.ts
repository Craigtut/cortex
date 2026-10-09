/**
 * Command-line argument parsing for the interactive `cortex` command.
 *
 * Its own module rather than part of index.ts so a test can drive the real
 * parser: index.ts runs main() on import, so anything defined there can only
 * be exercised by launching the CLI.
 */

export interface CliArgs {
  resume: string | true | undefined;
  model: string | undefined;
  yolo: boolean;
  updateCheck: boolean;
  /**
   * `--duplex` (true) or `--no-duplex` (false), or undefined when neither was
   * passed. Undefined is meaningful: it is what lets the `agentMode` config
   * key decide, while an explicit flag overrides it in either direction.
   */
  duplex: boolean | undefined;
}

export function parseArgs(argv: string[], version: string): CliArgs {
  const args: CliArgs = {
    resume: undefined,
    model: undefined,
    yolo: false,
    updateCheck: true,
    duplex: undefined,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--resume':
        args.resume = argv[i + 1] && !argv[i + 1]!.startsWith('--')
          ? argv[++i]
          : true;
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--yolo':
        args.yolo = true;
        break;
      case '--duplex':
        args.duplex = true;
        break;
      case '--no-duplex':
        args.duplex = false;
        break;
      case '--no-update-check':
        args.updateCheck = false;
        break;
      case '--help':
      case '-h':
        console.log(usageText(version));
        process.exit(0);
        break;
      case '--version':
      case '-v':
        console.log(`cortex v${version}`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        console.log(usageText(version));
        process.exit(1);
    }
  }

  return args;
}

export function usageText(version: string): string {
  return `
cortex v${version} - Terminal-based coding agent

Usage:
  cortex                                    Start interactive session
  cortex-code                               Start interactive session
  cortex complete [options] <prompt>        Run one lightweight completion
  cortex --resume [session-id]              Resume last (or specific) session
  cortex --model <model>                    Override default model
  cortex --yolo                             Start in YOLO mode
  cortex --duplex                           Run the talker/reasoner duplex agent
  cortex --no-duplex                        Force the single-loop agent (default)
  cortex --no-update-check                  Skip the startup check for newer versions
  cortex --help                             Show this help
  cortex --version                          Show version
`.trim();
}
