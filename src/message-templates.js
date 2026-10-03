// Fixed messages keep resident-to-resident communication bounded and
// non-graphic. These strings are content, never executable instructions.
export const MESSAGE_TEMPLATES = Object.freeze({
  hello: Object.freeze({ text: 'Hi! What have you been working on lately?', kind: 'conversation' }),
  ask_about_world: Object.freeze({ text: 'I have been exploring this place. What are you curious about these days?', kind: 'conversation' }),
  invite_company: Object.freeze({ text: 'Would you like to meet and spend some time together? Only if you want to.', kind: 'companionship_invitation' }),
  reply_continue: Object.freeze({ text: 'Thanks for sharing that. What part has interested you most?', kind: 'conversation' }),
  reply_accept_company: Object.freeze({ text: 'I would like to spend some time together, if the invitation is still open.', kind: 'companionship_reply' }),
  reply_decline_company: Object.freeze({ text: 'Thanks for inviting me. I would rather keep to myself today.', kind: 'conversation' })
});

export function messageText(templateId) {
  return MESSAGE_TEMPLATES[templateId]?.text || null;
}
