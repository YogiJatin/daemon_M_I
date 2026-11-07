const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: fs.createReadStream('C:\\Users\\yogid\\.gemini\\antigravity\\brain\\69528b9a-663b-4300-82a5-12617c972498\\.system_generated\\logs\\transcript_full.jsonl')
});

rl.on('line', line => {
  if (line.includes('"step_index":9907') || line.includes('"step_index": 9907')) {
    const obj = JSON.parse(line);
    console.log('9907 found! content len:', obj.content ? obj.content.length : 0);
    fs.writeFileSync('scripts/part1.txt', obj.content);
  }
  if (line.includes('"step_index":9947') || line.includes('"step_index": 9947')) {
    const obj = JSON.parse(line);
    console.log('9947 found! content len:', obj.content ? obj.content.length : 0);
    fs.writeFileSync('scripts/part2.txt', obj.content);
  }
  if (line.includes('"step_index":9949') || line.includes('"step_index": 9949')) {
    const obj = JSON.parse(line);
    console.log('9949 found! content len:', obj.content ? obj.content.length : 0);
    fs.writeFileSync('scripts/part3.txt', obj.content);
  }
});
rl.on('close', () => {
  console.log('Done scanning.');
});
