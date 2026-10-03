import { satisfiesVersion } from '../versions';

describe('satisfiesVersion', () => {
  it('compares dotted versions against one requirement', () => {
    expect(satisfiesVersion('2.39.1', '>=2.30')).toBe(true);
    expect(satisfiesVersion('2.29', '>=2.30')).toBe(false);
    expect(satisfiesVersion('3.12', '3.12')).toBe(true);
    expect(satisfiesVersion('3.12.0', '==3.12')).toBe(true);
    expect(satisfiesVersion('3.14', '<3.14')).toBe(false);
    expect(satisfiesVersion('3.14', '<=3.14')).toBe(true);
    expect(satisfiesVersion('3.14', '>3.13')).toBe(true);
    expect(satisfiesVersion('3.14', '=3.14.1')).toBe(false);
  });

  it('takes an odd requirement as met and an empty version as not', () => {
    expect(satisfiesVersion('1.0', 'weird')).toBe(true);
    expect(satisfiesVersion('1.0', '>=3.12,<3.15')).toBe(true);
    expect(satisfiesVersion('', '>=1')).toBe(false);
    expect(satisfiesVersion('a.b', '>=1')).toBe(false);
  });
});
