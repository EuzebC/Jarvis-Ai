import readline from 'node:readline';
import { setPassword } from './auth.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => s.startsWith(question) && rl.output.write(question);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Resets the Jarvis password from this computer. Signs out every device.
async function main() {
  if (process.argv[2] !== 'set-password') {
    console.log('Usage: npm run set-password');
    process.exit(1);
  }
  const password = await askHidden('New Jarvis password (at least 8 characters): ');
  if (password.length < 8) {
    console.error('Too short.');
    process.exit(1);
  }
  if ((await askHidden('Repeat it: ')) !== password) {
    console.error('The passwords do not match.');
    process.exit(1);
  }
  setPassword(password);
  console.log('Password saved. Every device has been signed out.');
}

main();
