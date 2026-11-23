/**
 * Sizing libuv's thread pool from inside the process.
 *
 * libuv reads UV_THREADPOOL_SIZE once, when the pool starts (on the first
 * submitted work). Up to libuv 1.51 (Node 22) it reads it with the C runtime's
 * getenv(). On Windows the C runtime keeps its own copy of the environment,
 * taken when the process started, and process.env changes the process's
 * environment, not that copy: libuv never sees the new value and starts its
 * default 4 threads. libuv 1.52 (Node 24) reads the process's environment
 * (uv_os_getenv), and on macOS and Linux getenv() always does.
 *
 * Where libuv can't see process.env, the only way to size the pool is to start
 * the process again with the variable in its environment.
 */
/** In the copy that setThreadpoolSize() starts: the process ID of the process that started it */
export declare const LAUNCHER_PID_VARIABLE = "DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID";
/** Kept in the OS command line so diagnostics can distinguish a copy from an independent nested server. */
export declare const LAUNCHER_PID_ARGUMENT = "--desktop-commander-threadpool-launcher-pid=";
/** Whether libuv sees a UV_THREADPOOL_SIZE set in process.env: everywhere but on Windows with a libuv before 1.52 */
export declare function processEnvReachesThreadpool(platform?: string, uvVersion?: string): boolean;
/**
 * Gives libuv's thread pool `size` threads (a UV_THREADPOOL_SIZE value). Call
 * it before any thread-pool work, before anything else sets the variable.
 *
 * - If process.env already has this value, it was there when Node started,
 *   and libuv reads it: nothing to do.
 * - Where libuv sees process.env (`envReachesThreadpool`), it sets the variable there.
 * - Elsewhere it runs this process again: the same Node, options, script and
 *   arguments, stdin, stdout and stderr, with the variable in the copy's
 *   environment. It waits for the copy and exits with the copy's exit code, so
 *   this process runs none of the code after the call. If the copy can't
 *   start, it returns, and the pool keeps libuv's default size.
 * - In that copy, it only makes sure the copy ends when the process that
 *   started it is gone.
 */
export declare function setThreadpoolSize(size: string, envReachesThreadpool?: boolean): void;
