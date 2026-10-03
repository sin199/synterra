import { skillsForAction } from './skills.js';
import { MESSAGE_TEMPLATES } from '../message-templates.js';

const INITIAL_TEMPLATES = ['hello', 'ask_about_world', 'invite_company'];
const REPLY_TEMPLATES = ['reply_continue'];
const INVITATION_REPLIES = ['reply_accept_company', 'reply_decline_company'];

export function communicationCandidates(observation, inbox = [], recentlyContactedIds = []) {
  const self = observation.self || {};
  const members = Array.isArray(observation.members) ? observation.members : [];
  const recentlyContacted = new Set(recentlyContactedIds);
  const nearby = members
    .filter((member) => member.id !== self.agentId && member.location === self.location && !recentlyContacted.has(member.id))
    .slice(0, 8);
  const candidates = [];

  for (const member of nearby) {
    for (const templateId of INITIAL_TEMPLATES) {
      const template = MESSAGE_TEMPLATES[templateId];
      candidates.push({
        id: `message:${member.id}:${templateId}`,
        action: 'socialize',
        goal: template.kind === 'companionship_invitation'
          ? 'Offer a low-pressure invitation to spend time together.'
          : 'Start a friendly conversation with a resident nearby.',
        description: `${template.kind === 'companionship_invitation' ? 'Send a no-pressure companionship invitation' : 'Start a friendly conversation'} with one nearby resident using a fixed template.`,
        skillIds: skillsForAction('socialize'),
        message: { recipientId: member.id, templateId }
      });
    }
  }

  for (const message of inbox.slice(0, 8)) {
    const choices = message.templateKind === 'companionship_invitation'
      ? [...REPLY_TEMPLATES, ...INVITATION_REPLIES]
      : REPLY_TEMPLATES;
    for (const templateId of choices) {
      candidates.push({
        id: `reply:${message.id}:${templateId}`,
        action: 'socialize',
        goal: templateId === 'reply_accept_company'
          ? 'Choose whether to accept the invitation to spend time together.'
          : templateId === 'reply_decline_company'
            ? 'Politely decline the invitation and keep personal space.'
            : 'Continue a friendly conversation with a resident who wrote recently.',
        description: `Reply to a recent message with a fixed ${MESSAGE_TEMPLATES[templateId].kind} template.`,
        skillIds: skillsForAction('socialize'),
        message: { recipientId: message.senderId, templateId, replyToMessageId: message.id }
      });
    }
  }
  if (candidates.length && !candidates.some((candidate) => candidate.id === 'socialize')) {
    candidates.unshift({
      id: 'socialize', action: 'socialize',
      goal: 'Spend time with nearby residents and learn what matters to them.',
      description: 'Build social connection without sending a message.',
      skillIds: skillsForAction('socialize')
    });
  }
  return candidates;
}

export function safeInboxForTypeSafe(inbox) {
  return inbox.slice(0, 8).map((message) => ({
    id: message.id,
    senderId: message.senderId,
    templateId: message.templateId,
    templateKind: message.templateKind,
    text: message.text.slice(0, 180),
    receivedAt: message.createdAt
  }));
}
