export function openDialog(dialog) {
  if (!dialog || dialog.open === true) {
    return;
  }

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }

  dialog.setAttribute("open", "open");
}

export function closeDialog(dialog) {
  if (!dialog) {
    return;
  }

  if (typeof dialog.close === "function" && dialog.open === true) {
    dialog.close();
    return;
  }

  dialog.removeAttribute("open");
}
