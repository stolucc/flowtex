# AthenaSwanCSIT

Before you edit anything, please read the following.

# File Structure

__MAIN is the main file which contains all custom formatting code. This file contains all the magic that makes it look what it is. As much as possible, we're trying to separate that from the contents. 

The main contents file is "\_body.tex". This file then includes all the various chapters and sections.

All (except maybe 1 or 2) tables are stored in their own file, in the folders tables1, tables2, and tables3, depending on whether the table belongs to Section 1, 2 or 3, respectively.

The file acro.sty is necessary because Overleaf doesn't seem to know the acro package. Do not touch it. 

# Making Changes

If you're not sure what you're doing, please don't make any changes. If you know your way around GitHub, you can hit 'edit' on a file, and create a Pull Request (PR) on a file by making changes in a branch. That's the best way to propose changes: any change you propose can then be reviewed before 'pulling them in'. 

- Hit edit
- Make changes as you see fit
- in the box 'Commit changes' below the editor, add a subject and a brief description of changes
- select "Create a new branch for this commit and start a pull request" (by default the other option is selected: Commit directly to the main branch)
- Give the new branch a descriptive name
- Hit the button "Commit changes"


# Local editing and compilation

The project is created with TeX Live Version 2022. Strongly advise to upgrade your LaTeX installation if you run a version older than 2021, because packages go out of date, and syntax/options change, which means that the project might not compile on your local machine. 