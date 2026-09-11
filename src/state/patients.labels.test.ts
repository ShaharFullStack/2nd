/**
 * TWO PATIENTS CALLED "J. SMITH".
 *
 * The app stores a display name and nothing else — no date of birth, no record number — which is the
 * right privacy call for an unencrypted shared tablet and which guarantees that sooner or later two
 * records carry the same name. If the picker, the banner and the reassign buttons then render two
 * identical controls, the one screen whose whole job is "getting this wrong must be hard" becomes a
 * coin flip, and the loser gets somebody else's ROM trend and somebody else's calibrated range.
 *
 * The invariant these tests pin: WITHIN A SAME-NAMED GROUP, NO TWO `display` STRINGS ARE EQUAL — with
 * the friendly disambiguator (the day they were last seen) preferred, and the id tail only as the
 * last resort that cannot collide.
 */
import { describe, expect, it } from 'vitest';
import type { Patient, SessionResult } from '../session/types.ts';
import { findNameMatches, labelIndex, labelPatients, nameKey, patientUsage, shortId } from './patients.ts';

function patient(id: string, name: string, patch: Partial<Patient> = {}): Patient {
  return { id, name, createdAt: 1_700_000_000_000, lastUsedAt: 0, ...patch };
}

const DAY = 86_400_000;

describe('telling same-named patients apart', () => {
  it('leaves a unique name completely alone — no noise where there is no ambiguity', () => {
    const labels = labelPatients([patient('a', 'Alma R.'), patient('b', 'Bram T.')]);
    expect(labels.map((l) => l.display)).toEqual(['Alma R.', 'Bram T.']);
    expect(labels.every((l) => !l.ambiguous && l.tag === '')).toBe(true);
  });

  it('never renders two identical labels for two patients with the same name', () => {
    const list = [patient('p1', 'J. Smith'), patient('p2', 'J. Smith'), patient('p3', 'J. Smith')];
    const usage = {
      p1: { sessions: 4, lastSessionAt: 1_700_000_000_000 },
      p2: { sessions: 4, lastSessionAt: 1_700_000_000_000 + 5 * DAY },
      p3: { sessions: 4, lastSessionAt: 0 },
    };
    const labels = labelPatients(list, usage);
    expect(labels.every((l) => l.ambiguous)).toBe(true);
    expect(new Set(labels.map((l) => l.display)).size).toBe(3);
    // The friendly disambiguator, not a hex suffix: "the one I saw on Tuesday".
    expect(labels[0].tag).toMatch(/^last session /);
    expect(labels[1].tag).toMatch(/^last session /);
    expect(labels[2].tag).toBe('no sessions yet');
  });

  it('falls back to the date added, then the id tail, when usage cannot separate them', () => {
    const same = { sessions: 0, lastSessionAt: 0 };
    const list = [
      patient('p1', 'J. Smith', { createdAt: 1_700_000_000_000 }),
      patient('p2', 'J. Smith', { createdAt: 1_700_000_000_000 + 9 * DAY }),
    ];
    const byDate = labelPatients(list, { p1: same, p2: same });
    expect(byDate.every((l) => l.tag.startsWith('added '))).toBe(true);
    expect(new Set(byDate.map((l) => l.display)).size).toBe(2);

    // Identical on every dimension the app records: the local id is the only thing left, and it is
    // the one thing that can never collide.
    const twins = [patient('pabc1234', 'J. Smith'), patient('pxyz9876', 'J. Smith')];
    const byId = labelPatients(twins, { pabc1234: same, pxyz9876: same });
    expect(byId.map((l) => l.tag)).toEqual(['id 1234', 'id 9876']);
    expect(new Set(byId.map((l) => l.display)).size).toBe(2);
  });

  it('always shows usage metadata on every row, ambiguous or not — the data was always there', () => {
    const [only] = labelPatients([patient('a', 'Alma R.')], { a: { sessions: 6, lastSessionAt: 1_700_000_000_000 } });
    expect(only.detail).toContain('6 sessions');
    expect(only.detail).toContain('last session');
    expect(only.detail).toContain('added');
  });

  it('treats case and stray whitespace as the same name — that is how a duplicate gets typed', () => {
    expect(nameKey('  j.  SMITH ')).toBe(nameKey('J. Smith'));
    const existing = [patient('p1', 'J. Smith')];
    expect(findNameMatches(existing, ' j. smith ').map((p) => p.id)).toEqual(['p1']);
    expect(findNameMatches(existing, 'J. Smythe')).toEqual([]);
    // Renaming a patient to their own name is not a collision with themselves.
    expect(findNameMatches(existing, 'J. Smith', 'p1')).toEqual([]);
    expect(findNameMatches(existing, '   ')).toEqual([]);
  });

  it('derives usage from the device-wide history, keyed per patient', () => {
    const rows = [
      { patientId: 'a', startedAt: 10 },
      { patientId: 'a', startedAt: 40 },
      { patientId: 'b', startedAt: 25 },
    ] as SessionResult[];
    expect(patientUsage(rows)).toEqual({
      a: { sessions: 2, lastSessionAt: 40 },
      b: { sessions: 1, lastSessionAt: 25 },
    });
  });

  it('exposes the same labels as a lookup, so every screen names a patient identically', () => {
    const list = [patient('p1', 'J. Smith'), patient('p2', 'J. Smith')];
    const usage = { p1: { sessions: 1, lastSessionAt: 1_700_000_000_000 }, p2: { sessions: 0, lastSessionAt: 0 } };
    const index = labelIndex(list, usage);
    const arr = labelPatients(list, usage);
    expect(index[arr[0].id].display).toBe(arr[0].display);
    expect(index[arr[1].id].display).toBe(arr[1].display);
  });

  it('shortens an id to a stable, non-identifying tail', () => {
    expect(shortId('pmtwr8kz1-f250ba')).toBe('50ba');
    expect(shortId('ab')).toBe('ab');
  });

  it('names the two built-in records for what they are rather than counting sessions alone', () => {
    const [dev, un] = labelPatients(
      [patient('device-test', 'Device test (not a patient)', { deviceTest: true }), patient('unassigned', 'Unassigned records', { unassigned: true })],
      { 'device-test': { sessions: 2, lastSessionAt: 5 }, unassigned: { sessions: 3, lastSessionAt: 7 } },
    );
    expect(dev.detail).toContain('not a person');
    expect(un.detail).toContain('before this device tracked patients');
  });
});
