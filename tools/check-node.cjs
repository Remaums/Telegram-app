/**
 * Vérifie la version de Node avant de démarrer.
 *
 * Écrit volontairement sans syntaxe moderne : sur un Node trop ancien, ce
 * fichier doit pouvoir s'exécuter pour afficher un message lisible. Sinon
 * l'utilisateur ne récolte qu'un « SyntaxError: Unexpected token '?' » au
 * milieu du serveur, qui ne dit rien du vrai problème.
 */
var required = 20;
var current = Number(process.versions.node.split('.')[0]);

if (current < required) {
  console.error(
    '\n  Node ' + process.versions.node + ' est trop ancien : il en faut ' + required + ' ou plus.\n' +
    '  (Le paquet « nodejs » des dépôts Ubuntu 22.04 est encore en version 12.)\n\n' +
    '  Pour installer une version récente :\n\n' +
    '    sudo apt remove -y nodejs npm\n' +
    '    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n' +
    '    sudo apt install -y nodejs\n' +
    '    hash -r && node -v\n'
  );
  process.exit(1);
}
