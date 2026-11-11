import torch.nn as nn

print("loading...")


class Noisy(nn.Module):
    def __init__(self):
        super().__init__()
        self.lin = nn.Linear(4, 2)

    def forward(self, x):
        print("forward!")
        return self.lin(x)
