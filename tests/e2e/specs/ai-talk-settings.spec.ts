import { test } from '../fixtures/app-fixture';
import { verifyAiTalkProfileDeletion } from '../fixtures/ai-talk-settings-workflow';

test('AI Talk deletes all connections durably and restores clean templates', async ({ app }, testInfo) => {
  await verifyAiTalkProfileDeletion(app, false, testInfo);
});
