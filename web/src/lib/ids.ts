import { customAlphabet } from 'nanoid';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
const _newId = customAlphabet(alphabet, 12);

export function newId(): string {
  return _newId();
}
