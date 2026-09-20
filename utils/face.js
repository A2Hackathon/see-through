// Simple deterministic mock embedding generator and similarity helper

export function getEmbeddingFromUri(uri) {
  const s = uri || '';
  // simple deterministic hash seed
  let seed = 0;
  for (let i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) | 0;

  const len = 128;
  const emb = new Array(len);
  for (let i = 0; i < len; i++) {
    // pseudo-random but deterministic values derived from seed
    const v = Math.sin(seed + i * 997) * 43758.5453;
    emb[i] = (v - Math.floor(v));
  }
  // normalize
  const norm = Math.sqrt(emb.reduce((a, b) => a + b * b, 0));
  return emb.map((x) => x / (norm || 1));
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
