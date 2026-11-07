const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: fs.createReadStream('C:\\Users\\yogid\\.gemini\\antigravity\\brain\\69528b9a-663b-4300-82a5-12617c972498\\.system_generated\\logs\\transcript_full.jsonl')
});

rl.on('line', line => {
  if (line.includes('worker/telegramConversation.ts') && line.includes('handleNonSlashMessage')) {
    const m = line.match(/"step_index":\s*(\d+)/);
    try {
      const obj = JSON.parse(line);
      const text = obj.content || '';
      if (text.includes('handleNonSlashMessage') || text.includes('processSingleMessage')) {
        console.log('Found match at step:', m ? m[1] : 'unknown', 'len:', text.length);
        fs.writeFileSync(`scripts/step_${m ? m[1] : 'x'}.txt`, text);
      }
    } catch {}
  }
});
