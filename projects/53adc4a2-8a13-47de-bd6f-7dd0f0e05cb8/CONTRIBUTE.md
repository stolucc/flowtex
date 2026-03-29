(1) Each WG chair will have access to the text pertaining to his/her
section. Each WG text is in a separate file. To change/evolve the text,
please do the following:

--download the *complete latex source* from Overleaf 

--Make a copy of the file you intend to edit and archive the *original*
locally, in case you need to rollback at a later stage.

--Change your copy as required. Remember, only change the information in
the file pertaining to your WG.

--Compile the entire document locally and check that you have not
introduced errors. Please ensure that you are aware of the special
meaning of characters like %, $, _, etc in Latex.

--Update the name of your altered file to include the edit date.

--It is a good idea to locally archive the copy also.

--Send the updated file, *only*, to Klaas. He will place the it into the
master.

(2) When changing text, please confine yourself to the body text. Please
don't edit any macros written by Klaas.

(3) All actions will be managed through the shared xls file. (More from
Klass on the format of this file this later).

If you need to create a new action, place it in the file and inform
Klaas. He will generate a label for you and place it back into the xls file.

If you need to change the wording of an existing action that was
contributed by your group:

    --Change the text in the xls file *and* also in the \newcommand{}
macro that has already been placed into your associated file by Klaas.
Again, please do not change any references. Doing so will break the
table of actions.

You may refer to any action in your section by simply using the
appropriate reference that Klaas will have placed the xls file - using
the \ref{} command.

This process should allow us all to change text safely, and relatively
independently of each other, without the overhead (or learning curve) of
using GIT.
