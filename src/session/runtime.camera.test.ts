/**
 * WHEN THE CAMERA IS ALLOWED TO STAY OPEN.
 *
 * The camera and the MediaPipe inference loop used to be released on no path at all: the runner was
 * built with `stopInputOnDispose: inputMode !== 'camera'` ("camera sessions keep the camera open for
 * the next song") and nothing else ever closed the device. After the last song of a visit the light
 * stayed on and the pipeline kept inferring — a recording indicator over an ended clinical session,
 * and a tablet that is flat by the afternoon.
 *
 * The rule is a single predicate, and these are its cases.
 */
import { describe, expect, it } from 'vitest';
import type { Screen } from '../state/store.ts';
import { useStore } from '../state/store.ts';
import { screenNeedsCamera, watchScreenChanges } from './runtime.ts';

describe('screenNeedsCamera', () => {
  it('holds the device only for the screens that consume frames within seconds', () => {
    // The camera-check → ROM → latency → play hand-over, where re-opening the device costs seconds
    // and throws away the filters' warm state mid-prescription.
    for (const screen of ['camera', 'rom', 'latency', 'play'] as Screen[]) {
      expect(screenNeedsCamera(screen), screen).toBe(true);
    }
  });

  it('releases it everywhere the session is over or has not been prescribed', () => {
    for (const screen of ['home', 'patients', 'mode', 'setup', 'results', 'history'] as Screen[]) {
      expect(screenNeedsCamera(screen), screen).toBe(false);
    }
  });

  it('releases it on the results screen — the patient has finished and left the chair', () => {
    // The exact case the reviewer saw in the running app. "Play again" re-opens it, which costs a
    // second at the start of a song that has a count-in anyway.
    expect(screenNeedsCamera('results')).toBe(false);
    expect(screenNeedsCamera('results', {})).toBe(false);
    expect(screenNeedsCamera('results', { handsFree: false })).toBe(false);
  });

  /**
   * …UNLESS THE PATIENT HAS BEEN DRIVING THE SESSION THEMSELVES.
   *
   * Results ends with "Play again" and "New session". A patient whose forearms are on the table, or
   * who is seated out of reach of the tablet, can press neither — and for a hemiparetic patient
   * reaching for it may not be possible at all. `handsFree` is not a preference: it is set by the
   * first dwell confirm, so it is evidence that this session was actually worked from the chair.
   */
  it('keeps it on results — and ONLY on results — for a session the patient confirmed hands-free', () => {
    expect(screenNeedsCamera('results', { handsFree: true })).toBe(true);
    for (const screen of ['home', 'patients', 'mode', 'setup', 'history'] as Screen[]) {
      expect(screenNeedsCamera(screen, { handsFree: true }), screen).toBe(false);
    }
  });
});

describe('the release rule is armed for the whole visit, not just for the play screen', () => {
  it('fires on arriving at a screen, whichever screen the app left', () => {
    const seen: Screen[] = [];
    const stop = watchScreenChanges((s) => seen.push(s));
    const { goto } = useStore.getState();
    goto('play');
    goto('play'); // not a change: no decision to make
    goto('results');
    goto('home');
    stop();
    goto('setup'); // nothing listening any more
    expect(seen).toEqual(['play', 'results', 'home']);
    // …and the rule applied to that sequence keeps the camera for exactly one of them.
    expect(seen.map((s) => screenNeedsCamera(s))).toEqual([true, false, false]);
  });
});
