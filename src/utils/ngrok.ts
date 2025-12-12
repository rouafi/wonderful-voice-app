import ngrok from "ngrok";

export async function startNgrok(port: number): Promise<string> {
  try {
    const url = await ngrok.connect({
      addr: port,
      authtoken: process.env.NGROK_AUTHTOKEN, // Optional: if you have an authtoken
    });
    console.log(`🌐 ngrok tunnel active: ${url}`);
    console.log(`📡 Webhook URL: ${url}/incoming-call`);
    return url;
  } catch (error) {
    console.error("❌ Failed to start ngrok:", error);
    throw error;
  }
}

export async function stopNgrok(): Promise<void> {
  try {
    await ngrok.kill();
    console.log("🛑 ngrok tunnel stopped");
  } catch (error) {
    console.error("❌ Failed to stop ngrok:", error);
  }
}
