// Removed the unauthenticated legacy simulator. Production uses the protected /api/run-calls worker.
export function action() { return new Response("Gone", { status: 410 }); }
export function loader() { return new Response("Gone", { status: 410 }); }
