/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;

declare module "*?worker&inline" {
  const WorkerFactory: { new (): Worker };
  export default WorkerFactory;
}
