import { createApp, analytics, server } from '@databricks/appkit';

await createApp({
  plugins: [analytics(), server()],
}).catch(console.error);
