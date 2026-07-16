const text = '从 2026年6月28日 到 2026年12月31日 还有 186 天';
const near = '还有';
const idx = text.indexOf(near);
console.log('idx', idx);
const win = text.slice(Math.max(0, idx-20), idx + near.length + 20);
console.log('window:', JSON.stringify(win));
const nums = [...win.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
console.log('nums:', nums);
