// Adds a Show / Hide button to every password field, so people can check what they typed.
// Fields go back to hidden when the form is sent, so browsers still offer to save the password.
(function () {
  const EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.1 9.1 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/></svg>';

  function setShown(input, button, shown) {
    input.type = shown ? 'text' : 'password';
    button.innerHTML = shown ? EYE_OFF : EYE;
    button.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    button.setAttribute('aria-pressed', String(shown));
  }

  function addToggle(input) {
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pw-toggle';
    wrap.appendChild(button);
    setShown(input, button, false);
    button.addEventListener('click', e => {
      e.preventDefault(); // the field sits inside a <label>
      setShown(input, button, input.type === 'password');
      input.focus();
    });
    if (input.form) input.form.addEventListener('submit', () => setShown(input, button, false));
  }

  document.querySelectorAll('input[type=password]').forEach(addToggle);
})();
