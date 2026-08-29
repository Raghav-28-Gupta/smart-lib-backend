// 127.0.0.1 rather than localhost on purpose: on Windows, Node resolves
// `localhost` to ::1 first, while uvicorn binds IPv4 only — that combination
// fails with ECONNREFUSED even though the service is up.
const AI_BACKEND_URL = process.env.AI_BACKEND_URL ?? 'http://127.0.0.1:8000'

// Node 18+ ships fetch natively, so there's no HTTP client dependency here.
// This is the only place the FastAPI service is reached from — the client never
// talks to it directly.
export async function checkAiBackendHealth() {
  const res = await fetch(`${AI_BACKEND_URL}/health`)
  if (!res.ok) throw new Error(`AI backend unhealthy: ${res.status}`)
  return res.json()
}

export interface RecommendResult {
  book_id: string
  score: number
  method: 'content' | 'collaborative' | 'hybrid'
}

// The real path is POST /recommend/books, not POST /recommend as
// SMARTLIB_PROJECT_CONTEXT.md §5.3 previously documented (fixed alongside
// this). Returns stub results ([]) until the Phase 3 model lands --
// recommendationService.ts is the one that falls back when this is empty.
export async function fetchRecommendations(userId: string, limit = 10): Promise<RecommendResult[]> {
  const res = await fetch(`${AI_BACKEND_URL}/recommend/books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, limit }),
  })
  if (!res.ok) throw new Error(`AI backend recommend failed: ${res.status}`)
  const data = (await res.json()) as { results: RecommendResult[] }
  return data.results
}
