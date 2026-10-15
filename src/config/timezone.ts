// Days and booking slots are built in the server's local time zone
// (bookingService.ts, resourceService.ts, adminMetrics.ts). Render runs in
// UTC while the library is in IST, so without TZ every slot shifts by five
// and a half hours. Production must set TZ=Asia/Kolkata (README, "Deploy").
export function timeZoneWarning(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === 'production' && !env.TZ) {
    return 'TZ is not set: library days and booking slots will use the server time zone (UTC on Render). Set TZ=Asia/Kolkata.'
  }
  return null
}
