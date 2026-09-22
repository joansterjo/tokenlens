import { expect, test } from 'vitest';
import { PROTOCOL_VERSION, PORT_DEVTOOLS } from '../../src/transport/protocol';
test('the frozen envelope survives JSON transfer', () => {
  const message = { v: PROTOCOL_VERSION, id: 'test', type: 'pick:start', payload: {} };
  expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  expect(PORT_DEVTOOLS(7)).toBe('devtools:7');
});
