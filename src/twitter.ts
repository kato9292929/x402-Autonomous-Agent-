export async function postToX(text: string): Promise<void> {
  const response = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Failed to post to X (${response.status}):`, body);
  } else {
    const data = await response.json() as { data?: { id?: string } };
    console.log(`Posted to X successfully. Tweet ID: ${data?.data?.id ?? "unknown"}`);
  }
}
