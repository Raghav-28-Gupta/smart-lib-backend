import crypto from 'node:crypto'
import { Router } from 'express'
import { AppError, UnauthorizedError } from '../lib/httpError'
import { logSweepFailure, logSweepResult, sweepBookings, type SweepResult } from '../services/noShowService'

export const internalRouter = Router()

// SHA-256 of a string. Both the configured token and the one sent are hashed before they
// are compared, so the two buffers handed to timingSafeEqual always have the same length
// (it throws otherwise, and a length-dependent early return would leak the token's length).
const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest()

function tokenMatches(sent: string, configured: string): boolean {
  return crypto.timingSafeEqual(digest(sent), digest(configured))
}

// Runs the no-show sweep (record the missed bookings, send the "starts soon" reminders). It is
// called by the scheduled GitHub Actions workflow (.github/workflows/sweep.yml), so it has no
// login: the only credential is the `x-sweep-token` header. Mounted outside /admin and without
// requireAuth on purpose; an admin's login token is no substitute for the sweep token.
//
//  - No SWEEP_TOKEN configured (unset or blank): the route does not exist. It falls through
//    to Express's own 404, so it cannot be told apart from a path that was never defined, and
//    an empty header can never match an empty secret. Read from process.env on every call.
//  - Wrong or missing token: 401. The token and the header are never logged.
//  - It AWAITS the sweep and answers `{ noShows, reminders, remaining }`.
//  - A sweep with a failed step (the result's `failed`) is answered 500 with the same counts
//    and `failed` in the body, and a sweep that threw (both steps failed) is a 500 too. The
//    workflow's `curl --fail-with-body` then fails and GitHub emails the owner: a 200 for a
//    sweep that could not run would let no-shows or reminders stop with nobody told.
internalRouter.post('/internal/sweep', async (req, res, next) => {
  const configured = process.env.SWEEP_TOKEN?.trim()
  if (!configured) {
    next()
    return
  }
  if (!tokenMatches(req.header('x-sweep-token') ?? '', configured)) {
    throw new UnauthorizedError('Invalid sweep token.')
  }

  let result: SweepResult
  try {
    result = await sweepBookings()
  } catch (error) {
    logSweepFailure(error)
    // Not the thrown error: its text can carry a row's data, and the error handler would log it whole.
    throw new AppError(500, 'The sweep failed.')
  }
  logSweepResult(result)
  res.status(result.failed ? 500 : 200).json(result)
})
