import { loadSeries } from "@/lib/data";

export const dynamic = "force-dynamic";

// GET /api/series?item=<item_code> → weekly + monthly rows for every state and the national series.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("item");
  const item = Number(raw);
  if (!raw || !Number.isInteger(item) || item < 0) {
    return Response.json({ error: "Pass ?item=<item_code>" }, { status: 400 });
  }
  try {
    return Response.json(await loadSeries(item));
  } catch (err) {
    console.error(err);
    return Response.json(
      { error: "Could not read the cube. Run `npm run build:cube` from the repo root." },
      { status: 500 },
    );
  }
}
