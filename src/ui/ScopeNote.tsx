/**
 * THE SCOPE STATEMENT, AND THE CONDITIONS THE MEASUREMENT WAS TAKEN IN — one shared line, on every
 * screen that shows a figure.
 *
 * The scope statement used to exist only in the README. The app meanwhile presented degrees, ranges
 * as a percentage of a calibrated range, timing bias in milliseconds, per-limb trends across weeks
 * and an exported "patient record" — and nowhere on any screen, or in any exported file, said that
 * these are webcam estimates from a game rather than clinical measurements.
 *
 * THE RULES THIS COMPONENT EXISTS TO KEEP:
 *  - it is NOT dismissible and NOT a dialog. A therapist runs several sessions a day; anything that
 *    has to be clicked away is read once and then trained away. This is a quiet line under the
 *    figures it qualifies, so it is in view exactly when a number is being read;
 *  - it is the SAME sentence everywhere, and the same sentence the export carries
 *    (`SCOPE_STATEMENT` in session/results.ts is the single source);
 *  - where a session's tracking quality is known it is stated in the same breath, because "what
 *    this is" and "how well it was measured today" are the two halves of the same caveat. A record
 *    with no tracking block says so rather than reading as a clean stream.
 */
import { SCOPE_SHORT, SCOPE_STATEMENT } from '../session/results.ts';
import {
  CALIBRATION_IN_SONG_NOTE,
  CALIBRATION_NOT_RECORDED,
  TRACKING_NOT_RECORDED,
  calibrationGrade,
  calibrationSentence,
  sessionCalibrationMeasurement,
  trackingGrade,
  trackingSentence,
} from '../session/tracking.ts';
import type { SessionResult, TrackingQuality } from '../session/types.ts';

/**
 * The scope line. `full` prints the whole statement (screens whose entire subject is measurement —
 * results, history); the default short form sits under a single card.
 */
export function ScopeNote({
  full = false,
  plain = false,
  testId = 'scope-note',
}: {
  full?: boolean;
  /** Drop the left rule — for a caller that already wraps this line and another one in `.scope-note`. */
  plain?: boolean;
  testId?: string;
}) {
  return (
    <p className={plain ? 'dim' : 'dim scope-note'} data-testid={testId} style={{ margin: 0 }}>
      {full ? SCOPE_STATEMENT : SCOPE_SHORT}
    </p>
  );
}

/**
 * The scope line WITH this session's tracking conditions beside it — for the screens that show a
 * stored measurement (results, history, the per-movement trend).
 *
 * `inputMode` is taken rather than assumed: a keyboard or autoplay run has no camera and no tracking
 * to describe, and printing "tracking not recorded" against it would imply a camera that failed.
 */
export function MeasurementNote({
  tracking,
  session,
  inputMode = 'camera',
  full = false,
  testId = 'measurement-note',
}: {
  tracking?: TrackingQuality | null;
  /**
   * The session whose RANGES these figures are percentages of, when the caller has it.
   *
   * The line beside `tracking` answers "how well was the camera working"; this one answers "how was
   * the scale itself arrived at", which is the other half of the same caveat and the one the in-song
   * path introduced. Optional because a caller may legitimately have only the tracking block (the
   * trend's per-point chips carry their own), and an absent session prints nothing rather than
   * guessing.
   */
  session?: Pick<SessionResult, 'lanes' | 'calibrationMode'> | null;
  inputMode?: 'camera' | 'keyboard' | 'autoplay';
  full?: boolean;
  testId?: string;
}) {
  const grade = tracking ? trackingGrade(tracking) : null;
  const calibration = session ? sessionCalibrationMeasurement(session) : null;
  const calGrade = calibration ? calibrationGrade(calibration) : null;
  const method = calibration?.method ?? null;
  return (
    <div className="stack scope-note" style={{ gap: 4 }} data-testid={testId}>
      <p className="dim" style={{ margin: 0 }}>
        {full ? SCOPE_STATEMENT : SCOPE_SHORT}
      </p>
      {inputMode === 'camera' && (
        <p className="dim" style={{ margin: 0 }} data-testid={`${testId}-tracking`}>
          {tracking ? (
            <>
              {/* The grade is a word, not a colour on its own: "fair" and "poor" are the two states
                  that change how the figures above may be read, and they say so in the sentence. */}
              <span
                className={grade === 'good' ? 'badge badge-ok' : grade === 'fair' ? 'badge badge-warn' : 'badge badge-bad'}
                data-testid={`${testId}-grade`}
              >
                tracking {grade}
              </span>{' '}
              {trackingSentence(tracking)}
            </>
          ) : (
            TRACKING_NOT_RECORDED
          )}
        </p>
      )}
      {/* AND WHERE THE 0–100 % ITSELF CAME FROM. Every range figure above is a percentage OF a range,
          and a range learned while the patient was chasing notes is not the same measurement as one
          taken from a rest hold and three maximum-effort repetitions. Absent reads as absent. */}
      {inputMode === 'camera' && session && (
        <p className="dim" style={{ margin: 0 }} data-testid={`${testId}-calibration`}>
          <span
            className={calGrade === 'good' ? 'badge badge-ok' : calGrade === 'fair' ? 'badge badge-warn' : 'badge badge-bad'}
            data-testid={`${testId}-calibration-grade`}
          >
            range {method === 'in_song' ? 'learned in song' : method === 'rom_screen' ? 'measured' : 'not recorded'}
          </span>{' '}
          {calibration
            ? method === 'in_song'
              ? CALIBRATION_IN_SONG_NOTE
              : calibrationSentence(calibration)
            : CALIBRATION_NOT_RECORDED}
        </p>
      )}
    </div>
  );
}

export default ScopeNote;
