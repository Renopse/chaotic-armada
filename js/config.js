// Formulaire Google pour les commentaires des joueurs.
// formId : identifiant de l'URL « https://docs.google.com/forms/d/e/<formId>/viewform »
// fields : identifiants « entry.XXXX » des questions (visibles dans le lien prérempli du formulaire).
export const FEEDBACK = {
  formId: '',
  fields: {
    message: '', // question « Commentaire » (paragraphe)
    context: '', // question « Contexte » (réponse courte)
    name: '',    // question « Nom » (réponse courte)
  },
};
export const feedbackReady = () => !!(FEEDBACK.formId && FEEDBACK.fields.message);
