// Token secrets exist only in the creation dialog and never in browser storage.
export function createTokenPanel({ api, onUnauthorized }) {
  const $ = (id) => document.getElementById(id);
  let autoLabel = "";
  let rows = [],
    installations = [],
    cursor = null,
    editing = null,
    deleting = null,
    generation = 0,
    busy = false;
  const text = (tag, cls, value) => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = value;
    return n;
  };
  function message(value = "") {
    $("token-message").textContent = value;
    $("token-message").hidden = !value;
  }
  function error(id, value) {
    $(id).textContent = value;
    $(id).hidden = !value;
  }
  function status(row) {
    return row.revoked_at != null
      ? "Revoked"
      : row.expires_at != null && row.expires_at <= Date.now()
        ? "Expired"
        : "Active";
  }
  function date(value) {
    return value ? new Date(value).toLocaleString() : "Never";
  }
  function localTime(value) {
    const d = new Date(value);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 19);
  }
  function render() {
    const active = [],
      revoked = [];
    rows.forEach((row) => {
      const card = text("article", "token-row", "");
      const details = text("div", "token-details", "");
      const heading = text("div", "token-title", "");
      heading.append(text("strong", "", row.label || "Unnamed token"));
      if (row.current) heading.append(text("span", "badge", "This browser"));
      const state = status(row);
      heading.append(
        text("span", "badge " + (state === "Active" ? "" : "stale"), state),
      );
      const role = row.can_manage_tokens
        ? "Read + token management"
        : row.scope === "write"
          ? "Write"
          : "Read";
      details.append(
        heading,
        text("code", "token-id", row.id),
        text(
          "p",
          "token-meta",
          `${role}${row.installation_id ? " / " + (installations.find((i) => i.id === row.installation_id)?.label || row.installation_id) : " / Workspace"} · Expires: ${date(row.expires_at)}`,
        ),
      );
      if (row.parent_token_id)
        details.append(
          text(
            "p",
            "token-meta",
            "Browser credential · inherits its originating token’s access",
          ),
        );
      const actions = text("div", "token-actions", "");
      if (row.revoked_at == null) {
        for (const [label, fn] of [
          ["Edit", () => edit(row)],
          ["Delete", () => confirmDelete(row)],
        ]) {
          const button = text(
            "button",
            "button " + (label === "Delete" ? "danger subtle" : ""),
            label,
          );
          button.type = "button";
          button.disabled = row.protected;
          button.onclick = fn;
          if (row.protected)
            button.title =
              "This credential supports your current login. Use another management session to change it.";
          actions.append(button);
        }
        if (row.protected)
          actions.append(text("span", "token-meta", "Current login protected"));
      }
      card.append(details, actions);
      (row.revoked_at == null ? active : revoked).push(card);
    });
    $("token-list").replaceChildren(...active);
    $("token-revoked-list").replaceChildren(...revoked);
    $("token-revoked").hidden = !revoked.length;
    $("token-revoked-count").textContent = revoked.length;
    if (!active.length)
      $("token-list").append(
        text(
          "div",
          "empty",
          cursor
            ? "No unrevoked tokens in the loaded results. Load more below."
            : "No active or expired tokens.",
        ),
      );
    $("token-more").hidden = !cursor;
  }
  async function load(more = false) {
    if (busy) return;
    busy = true;
    const current = generation;
    $("token-reload").disabled = true;
    $("token-more").disabled = true;
    message();
    try {
      const access = await api("/v1/token-access");
      if (current !== generation) return;
      $("token-locked").hidden = access.can_manage_tokens;
      $("token-controls").hidden = !access.can_manage_tokens;
      if (!access.can_manage_tokens) return;
      const data = await api(
        "/v1/tokens" +
          (more && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (current !== generation) return;
      rows = more ? [...rows, ...data.tokens] : data.tokens;
      installations = data.installations;
      cursor = data.cursor;
      render();
    } catch (e) {
      if (current === generation) {
        onUnauthorized(e);
        message(e.message);
      }
    } finally {
      if (current === generation) {
        busy = false;
        $("token-reload").disabled = false;
        $("token-more").disabled = false;
      }
    }
  }
  function edit(row = null) {
    editing = row;
    autoLabel = "";
    error("token-form-error", "");
    $("token-editor-title").textContent = row ? "Edit token" : "Create token";
    $("token-save").textContent = row ? "Save changes" : "Create token";
    $("token-editor-note").textContent = row
      ? "Update the label or expiration. The role and installation are fixed."
      : "Read tokens view workspace data. Write tokens report for an existing installation and can authorize browser login.";
    $("token-label").value = row?.label || "";
    $("token-scope").value = row?.scope || "read";
    $("token-scope").disabled = !!row;
    $("token-installation").replaceChildren(
      ...installations
        .filter((i) => i.disabled_at == null || i.id === row?.installation_id)
        .map((i) => {
          const option = text("option", "", i.label + " / " + i.id);
          option.value = i.id;
          return option;
        }),
    );
    if (row?.installation_id)
      $("token-installation").value = row.installation_id;
    $("token-installation").disabled = !!row;
    $("token-no-expiry").checked = row ? row.expires_at === null : false;
    $("token-no-expiry").disabled = !!row?.parent_token_id;
    $("token-expiry").value = localTime(
      row?.expires_at ?? Date.now() + 30 * 86400000,
    );
    changeRole();
    changeExpiry();
    $("token-editor").showModal();
    $("token-label").focus();
  }
  function changeRole() {
    $("token-installation-field").hidden = $("token-scope").value !== "write";
    $("token-installation").required = $("token-scope").value === "write";
    updateDefaultLabel();
  }
  function updateDefaultLabel() {
    if (editing) {
      $("token-label").required = true;
      return;
    }
    const field = $("token-label"),
      write = $("token-scope").value === "write";
    const machine = installations.find(
      (i) => i.id === $("token-installation").value,
    );
    const next = write
      ? (machine?.hostname || machine?.label || machine?.id || "").slice(0, 100)
      : "";
    if (!field.value.trim() || field.value === autoLabel) {
      field.value = next;
      autoLabel = next;
    }
    field.required = !write;
    field.placeholder = write
      ? "Defaults to hostname"
      : "e.g. dashboard viewer";
  }
  function changeExpiry() {
    $("token-expiry").disabled = $("token-no-expiry").checked;
    $("token-expiry").required = !$("token-no-expiry").checked;
  }
  function clearSecret() {
    $("token-secret").value = "";
    $("token-copy-message").textContent = "";
  }
  function confirmDelete(row) {
    deleting = row;
    error("token-delete-error", "");
    $("token-delete-description").textContent =
      `Revoke “${row.label || row.id}”?`;
    $("token-delete-dialog").showModal();
    $("token-delete-cancel").focus();
  }
  $("token-create").onclick = () => edit();
  $("token-reload").onclick = () => load();
  $("token-more").onclick = () => load(true);
  $("token-scope").onchange = changeRole;
  $("token-installation").onchange = updateDefaultLabel;
  $("token-no-expiry").onchange = changeExpiry;
  $("token-editor-close").onclick = $("token-cancel").onclick = () =>
    $("token-editor").close();
  $("token-secret-done").onclick = () => {
    $("token-secret-dialog").close();
    clearSecret();
  };
  $("token-secret-dialog").addEventListener("close", clearSecret);
  $("token-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("token-secret").value);
      $("token-copy-message").textContent = "Copied.";
    } catch {
      $("token-secret").select();
      $("token-copy-message").textContent =
        "Select and copy this secret manually.";
    }
  };
  $("token-form").onsubmit = async (event) => {
    event.preventDefault();
    const current = generation;
    $("token-save").disabled = true;
    error("token-form-error", "");
    const expires = $("token-no-expiry").checked
      ? null
      : new Date($("token-expiry").value).getTime();
    if (
      expires !== null &&
      (!Number.isFinite(expires) || expires <= Date.now())
    ) {
      error("token-form-error", "Choose a future expiration.");
      $("token-save").disabled = false;
      return;
    }
    const payload = {
      label: $("token-label").value.trim(),
      expires_at: expires,
    };
    if (editing) payload.expected_updated_at = editing.updated_at;
    else {
      payload.scope = $("token-scope").value;
      payload.installation_id =
        payload.scope === "write" ? $("token-installation").value : null;
    }
    try {
      const result = await api(
        editing ? "/v1/tokens/" + encodeURIComponent(editing.id) : "/v1/tokens",
        payload,
        editing ? "PATCH" : "POST",
      );
      if (current !== generation) return;
      $("token-editor").close();
      if (!editing) {
        $("token-secret").value = result.token;
        $("token-secret-note").textContent =
          payload.scope === "write"
            ? "Use this credential to configure the selected reporter installation."
            : "Use this credential in a viewer that needs workspace statistics.";
        $("token-secret-dialog").showModal();
      }
      await load();
    } catch (e) {
      if (current === generation) {
        onUnauthorized(e);
        error("token-form-error", e.message);
      }
    } finally {
      if (current === generation) $("token-save").disabled = false;
    }
  };
  $("token-delete-cancel").onclick = () => $("token-delete-dialog").close();
  $("token-delete-confirm").onclick = async () => {
    if (!deleting) return;
    const current = generation;
    $("token-delete-confirm").disabled = true;
    error("token-delete-error", "");
    try {
      await api("/v1/tokens/" + encodeURIComponent(deleting.id), {}, "DELETE");
      if (current !== generation) return;
      $("token-delete-dialog").close();
      await load();
      message("Token revoked. Clients using it can no longer authenticate.");
    } catch (e) {
      if (current === generation) {
        onUnauthorized(e);
        error("token-delete-error", e.message);
      }
    } finally {
      if (current === generation) $("token-delete-confirm").disabled = false;
    }
  };
  function reset() {
    generation++;
    rows = [];
    installations = [];
    cursor = null;
    editing = null;
    deleting = null;
    busy = false;
    clearSecret();
    $("token-list").replaceChildren();
    $("token-revoked-list").replaceChildren();
    $("token-revoked").open = false;
    $("token-revoked").hidden = true;
    $("token-revoked-count").textContent = "0";
    for (const id of [
      "token-editor",
      "token-delete-dialog",
      "token-secret-dialog",
    ])
      $(id).close();
    $("token-save").disabled = false;
    $("token-delete-confirm").disabled = false;
  }
  return { load, reset };
}
