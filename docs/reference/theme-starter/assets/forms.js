"use strict";
document.querySelectorAll("form[data-pcms-form]").forEach(form => {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const status = form.querySelector("[data-form-status]");
    const values = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type="checkbox"]').forEach(input => { values[input.name] = input.checked; });
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.hidden = false;
    try {
      const response = await fetch(form.action, {method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({values,source_url:location.href})});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "Submission failed");
      status.textContent = body.success?.message || "Request received";
      form.reset();
    } catch(error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
});
