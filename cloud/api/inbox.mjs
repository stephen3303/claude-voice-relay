// Adding a message to a user's inbox (pk USER#<sub>, sk MSG#<000000id>, expires after a week): shared by the
// Voice Lambda (index.mjs) and the agent runner (cloud/runner/main.mjs), which writes its agents' answers directly.
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { INBOX_KEEP_S } from './voice.mjs';

export async function addMessage(db, table, user, text) {
  const seq = await db.send(new UpdateCommand({
    TableName: table, Key: { pk: `USER#${user}`, sk: 'SEQ' },
    UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'UPDATED_NEW',
  }));
  const id = seq.Attributes.n;
  await db.send(new PutCommand({ TableName: table, Item: {
    pk: `USER#${user}`, sk: `MSG#${String(id).padStart(9, '0')}`, id, text, at: Date.now(),
    expires: Math.floor(Date.now() / 1000) + INBOX_KEEP_S,
  } }));
  return id;
}
