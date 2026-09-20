export async function appendImageFile(formData, fieldName, uri, filename) {
  const response = await fetch(uri);
  const blob = await response.blob();
  formData.append(fieldName, blob, filename);
}