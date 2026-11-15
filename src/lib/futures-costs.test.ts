import { expect, it } from 'vitest';
import { futuresTax } from './futures-costs';

it('rounds the positive tax per contract per side before multiplying lots', () => {
    expect(futuresTax(42499, 10, .00002)).toBe(8);
    expect(futuresTax(42500, 10, .00002)).toBe(9);
    expect(futuresTax(42500, 10, .00002, 2)).toBe(18);
    expect(futuresTax(100, 10, 0)).toBe(0);
});
