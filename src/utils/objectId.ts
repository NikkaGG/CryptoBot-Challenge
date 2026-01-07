import { ObjectId } from 'mongodb';
import { appError } from '../errors.js';

export function parseObjectId(id: string, name = 'id'): ObjectId {
  if (!ObjectId.isValid(id)) {
    throw appError('INVALID_ID', `Invalid ${name}`, 400);
  }
  return new ObjectId(id);
}
