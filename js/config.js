// Formulaire Google pour les commentaires des joueurs.
// formId : identifiant de l'URL « https://docs.google.com/forms/d/e/<formId>/viewform »
// fields : identifiants « entry.XXXX » des questions (visibles dans le lien prérempli du formulaire).
export const FEEDBACK = {
  formId: '1FAIpQLSe3mNqZwlcM2EfrcuYkJyBqYwgYJNYY7t149bphM9tHTkJtjQ',
  fields: {
    message: 'entry.1812651157', // question « Commentaire » (paragraphe)
    context: 'entry.770270842', // question « Contexte » (réponse courte)
    name: 'entry.1295619619',    // question « Nom » (réponse courte)
  },
};
export const feedbackReady = () => !!(FEEDBACK.formId && FEEDBACK.fields.message);
