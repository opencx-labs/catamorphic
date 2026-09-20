// Appends a timestamped marker to markers.jsonl, relative to the capture start.
import fs from 'node:fs';
const start=JSON.parse(fs.readFileSync(new URL('./start.json',import.meta.url))).start;
const t=(Date.now()-start)/1000;
fs.appendFileSync(new URL('./markers.jsonl',import.meta.url),JSON.stringify({t,event:process.argv.slice(2).join(' ')})+'\n');
console.log(t.toFixed(2),process.argv.slice(2).join(' '));
