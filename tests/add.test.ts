import { add } from '../src/app';

describe('Add two number', () => {
  test('should return the sum of two integers', () => {
    expect(add(2, 5)).toBe(7);
  });
});
