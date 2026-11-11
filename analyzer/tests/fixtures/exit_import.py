import sys

import torch.nn as nn

sys.exit(2)


class ExitsOnImport(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 2)

    def forward(self, x):
        return self.fc(x)
