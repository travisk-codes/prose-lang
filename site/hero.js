// A reading list, in JavaScript.
const books = [["Middlemarch", 880], ["Piranesi", 272]];
for (const [title, pages] of books) {
  const size = pages > 500 ? "long" : "short";
  console.log(`${title} is a ${size} book.`);
}
