export function createURI(input: string) {
  return input
    .toLowerCase() // Convert to lowercase
    .trim() // Trim any extraneous whitespace
    .replace(/\s+/g, "-") // Replace spaces with a single dash
    .replace(/[^a-z0-9\-]/g, ""); // Remove special characters (excluding dashes)
}

export function getCurrentDate() {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0"); // Ensure two digits for day
  const month = String(today.getMonth() + 1).padStart(2, "0"); // Months are zero-based, add 1
  const year = String(today.getFullYear()).slice(-2); // Get the last two digits of the year

  return `${day}-${month}-${year}`;
}
