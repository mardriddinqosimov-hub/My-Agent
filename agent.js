// CLI interface — run with: node agent.js
import 'dotenv/config';
import readline from 'readline';
import chalk from 'chalk';
import { chat } from './core.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const history = [];

function banner() {
  console.log(chalk.cyan('\n╔══════════════════════════════════════╗'));
  console.log(chalk.cyan('║       Personal Agent  (OpenAI)       ║'));
  console.log(chalk.cyan(`║  Model: ${MODEL.padEnd(28)}║`));
  console.log(chalk.cyan('║  Type "exit" or Ctrl+C to quit       ║'));
  console.log(chalk.cyan('╚══════════════════════════════════════╝\n'));
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(chalk.red('Error: OPENAI_API_KEY not set in .env'));
    process.exit(1);
  }

  banner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise(resolve => rl.question(chalk.green('You: '), resolve));

  while (true) {
    const input = (await prompt()).trim();
    if (!input) continue;
    if (['exit', 'quit'].includes(input.toLowerCase())) {
      console.log(chalk.yellow('Goodbye.')); rl.close(); break;
    }
    if (input === '/clear') { history.length = 0; console.log(chalk.dim('History cleared.\n')); continue; }
    if (input === '/help') {
      console.log(chalk.cyan('\nCommands: /clear, exit\nTools: read_file, write_file, list_files, run_js, fetch_url, save_note, search_notes\n'));
      continue;
    }

    try {
      process.stdout.write(chalk.blue('Agent: '));
      const reply = await chat(input, history, (tool) => process.stdout.write(chalk.dim(`[${tool}] `)));
      console.log(chalk.white(reply) + '\n');
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}\n`));
    }
  }
}

main();
