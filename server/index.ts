import { createApp, attachFrontend } from './app';
const runtime=createApp();
await attachFrontend(runtime.app);
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3100);
const server=runtime.app.listen(port,host,()=>console.log(`LibTV Studio running at http://${host}:${port}`));
let shuttingDown=false;
function shutdown(){if(shuttingDown)return;shuttingDown=true;runtime.jobs.stop();server.close(()=>{runtime.close();process.exit(0)});setTimeout(()=>process.exit(0),10000).unref()}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
