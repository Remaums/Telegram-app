"""Simulation d'un tri de 10 fiches. Toutes les données sont inventées."""
import random
import sys
import time

# Codes postaux autour de Genève et de Lausanne
LOCALITES = [
    ("1200", "Genève"), ("1205", "Genève"), ("1212", "Grand-Lancy"),
    ("1217", "Meyrin"), ("1218", "Le Grand-Saconnex"), ("1226", "Thônex"),
    ("1227", "Carouge"), ("1290", "Versoix"), ("1260", "Nyon"),
    ("1196", "Gland"), ("1110", "Morges"), ("1003", "Lausanne"),
    ("1004", "Lausanne"), ("1008", "Prilly"), ("1009", "Pully"),
    ("1020", "Renens"), ("1024", "Ecublens"), ("1095", "Lutry"),
]
NB_FICHES = 10


def barre(n, total, largeur=30):
    plein = int(largeur * n / total)
    sys.stdout.write(f"\r[{'#' * plein}{'.' * (largeur - plein)}] {n}/{total}")
    sys.stdout.flush()


def main():
    print("Chargement des fiches...")
    time.sleep(1)

    fiches = []
    for i in range(1, NB_FICHES + 1):
        code, ville = random.choice(LOCALITES)
        fiches.append({"code": code, "ville": ville, "annee": random.randint(1950, 1970)})
        time.sleep(random.uniform(0.2, 0.6))
        barre(i, NB_FICHES)
    print("\nTri en cours...")
    time.sleep(1.5)

    par_code = sorted(fiches, key=lambda f: f["code"])
    par_annee = sorted(f["annee"] for f in fiches)

    print(f"\nFiches traitées : {NB_FICHES}")
    print("Liste code postale :")
    for i, f in enumerate(par_code, 1):
        print(f"{i}-{f['code']} : {f['ville']}")
    print("Année de naissance :")
    for i, annee in enumerate(par_annee, 1):
        print(f"{i}- {annee}")


if __name__ == "__main__":
    main()
