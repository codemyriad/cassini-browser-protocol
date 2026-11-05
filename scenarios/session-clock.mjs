// The driver's session clock (D68 shared test 2). SPEC: the session origin is a wall-clock
// Date.now(); a capturing document maps it onto its own monotonic clock once and never reads the
// wall clock again. The driver does the same, at the origin's own instant, so its requested and
// observed times share the apps' monotonic timeline: a wall clock that drifts or steps during a
// run (a hosted VM's ran 500 ppm fast) can no longer move them.
//
// monotonic() is the system's monotonic clock in milliseconds (process.hrtime:
// CLOCK_MONOTONIC on Linux, mach_absolute_time on macOS). Unlike performance.now(), which each
// process counts from its own start, it is one clock for every process on the machine, so the
// control relay's frame stamps and the driver's readings compare directly.
export const monotonic = () => Number(process.hrtime.bigint()) / 1e6;

// One reading of where the wall clock stood at a monotonic instant: the wall reading between two
// monotonic ones.
export function wallPair({ wall = Date.now, mono = monotonic } = {}) {
  const before = mono(), atWall = wall(), after = mono();
  return { mono: (before + after) / 2, wall: atWall };
}

// Maps a wall-clock origin (Date.now() ms) onto the monotonic clock once, at the origin's own
// instant. An app maps it when its recording starts; the driver learns it later (Mac #149: about
// 2.35 s), and a wall clock slewing 510 ppm on a hosted VM moved a mapping read then by 1.2 ms
// against the app's, enough to put a selection stamped at once before its request. So `pairs`
// are wallPair readings the caller took while the origin was being taken (from before Record
// until the extension reports it); one more is read now. The origin is placed linearly between
// the two readings in a row that bracket it in wall time; with none, from the reading nearest it.
// at(m) is the session time of a monotonic reading m; now() reads it.
export function sessionClock(originMs, { pairs = [], wall = Date.now, mono = monotonic } = {}) {
  const readings = [...pairs, wallPair({ wall, mono })].sort((a, b) => a.mono - b.mono);
  let originMono = null;
  for (let i = 1; i < readings.length && originMono === null; i++) {
    const a = readings[i - 1], b = readings[i];
    if (a.wall <= originMs && originMs <= b.wall && b.wall > a.wall) originMono = a.mono + (originMs - a.wall) * (b.mono - a.mono) / (b.wall - a.wall);
  }
  if (originMono === null) {
    const near = readings.reduce((best, r) => (Math.abs(r.wall - originMs) < Math.abs(best.wall - originMs) ? r : best));
    originMono = near.mono - (near.wall - originMs);
  }
  return { originMono, at: m => m - originMono, now: () => mono() - originMono };
}
